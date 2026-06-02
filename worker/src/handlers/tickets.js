/**
 * tickets.js — event info, seat map, checkout initiation and completion.
 *
 * CHECKOUT FLOW:
 *   1. GET  /api/event           → event details + seat map
 *   2. POST /api/checkout/init   → get checkout token + CAPTCHA challenge
 *   3. POST /api/checkout/complete → buy tickets (atomic via Durable Object)
 */

import { issueCheckoutToken, consumeCheckoutToken } from "../security/token-rotation.js";
import { getBotState } from "../bots/defender.js";
import { issueCaptcha, validateCaptcha } from "../security/captcha.js";
import { checkHoneypot } from "../security/honeypot.js";
import { analyzeSession, recordAction } from "../security/behavioral.js";
import { checkFingerprint } from "../security/fingerprint.js";
import { validateSessionBinding, getSession } from "../security/session-binding.js";
import { applyScoreDeltas, SCORE_DELTAS } from "../security/anomaly-score.js";
import { logRequest } from "../utils/logger.js";
import { jsonResponse, getIP, getUA, getSessionId } from "./shared.js";
import { enqueue, checkQueue } from "../security/queue.js";

export async function handleGetEvent(request, env, config) {
  const sessionId = getSessionId(request);

  if (sessionId) {
    await recordAction(env, sessionId, "event_view", Date.now());
    const queue = await enqueue(env, config, sessionId);
    if (!queue.admitted) {
      return jsonResponse({ queued: true, waitMs: queue.waitMs, admitAt: queue.admitAt });
    }
  }

  // Get ticket counter — fallback gracefully if DO not initialized yet
  let count = 0, total = 0;
  try {
    const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
    const res = await counterStub.fetch("http://do/counter", {
      method: "POST",
      body: JSON.stringify({ action: "status" }),
    });
    const data = await res.json();
    count = data.count ?? 0;
    total = data.total ?? 0;
  } catch (e) {
    // DO not initialized — return empty state without crashing
    return jsonResponse({
      event: eventInfo(),
      tickets_remaining: 0,
      tickets_total: 0,
      seats: [],
      not_initialized: true,
    });
  }

  // Bot state for adjusted remaining count
  let totalBotTickets = 0;
  try {
    const sim = (await env.KV.get("simulation", "json")) || {};
    const botState = await getBotState(env, total, config, Date.now());
    totalBotTickets = botState.totalBotTickets;
  } catch (_) {}

  const takenSeats = (await env.KV.get("taken_seats", "json")) || [];
  const seats = buildSeatMap(total, takenSeats);

  return jsonResponse({
    event: eventInfo(),
    tickets_remaining: Math.max(0, count - totalBotTickets),
    tickets_total: total,
    seats,
  });
}

export async function handleCheckoutInit(request, env, config) {
  const body = await request.json().catch(() => ({}));
  const { sessionId, seats, canvasFingerprint } = body;
  const ip = getIP(request);
  const ua = getUA(request);

  if (!sessionId || !seats?.length) {
    return jsonResponse({ error: "missing_fields" }, 400);
  }

  const binding = await validateSessionBinding(env, sessionId, ip, ua);
  if (!binding.valid) return jsonResponse({ error: binding.reason }, 401);
  if (binding.session.banned) {
    return jsonResponse({ error: "session_banned", anomalyScore: binding.session.anomalyScore }, 403);
  }

  const queue = await checkQueue(env, sessionId);
  if (!queue.admitted) {
    return jsonResponse({ queued: true, waitMs: queue.waitMs });
  }

  const deltas = [];
  if (binding.anomalyDelta > 0)
    deltas.push({ delta: binding.anomalyDelta, reason: `session_binding (${binding.reasons.join(",")})` });

  const fpResult = await checkFingerprint(env, config, sessionId, canvasFingerprint, request);
  if (fpResult.score > 0)
    deltas.push({ delta: fpResult.score, reason: `fingerprint (${fpResult.reasons.join(",")})` });

  await recordAction(env, sessionId, "checkout_init", Date.now());
  const behResult = await analyzeSession(env, sessionId, config);
  if (behResult.suspicious)
    deltas.push({ delta: SCORE_DELTAS.behavioral_flag, reason: `behavioral (${behResult.reasons.join(",")})` });

  if (deltas.length > 0) {
    const scoreResult = await applyScoreDeltas(env, config, sessionId, deltas);
    if (scoreResult?.banned) {
      return jsonResponse({ error: "session_banned", anomalyScore: scoreResult.anomalyScore }, 403);
    }
  }

  const { token, expires_in } = await issueCheckoutToken(env, config, sessionId, binding.session.accountId, seats);
  const captcha = await issueCaptcha(env, config);

  await logRequest(env, { type: "checkout_init", sessionId, ip, seats });
  return jsonResponse({ checkoutToken: token, expires_in, captcha });
}

export async function handleCheckoutComplete(request, env, config) {
  const body = await request.json().catch(() => ({}));
  const { sessionId, checkoutToken, captchaChallenge, captchaSolution, payment } = body;
  const ip = getIP(request);
  const ua = getUA(request);

  if (!sessionId || !checkoutToken) {
    return jsonResponse({ error: "missing_fields" }, 400);
  }

  const binding = await validateSessionBinding(env, sessionId, ip, ua);
  if (!binding.valid) return jsonResponse({ error: binding.reason }, 401);
  if (binding.session.banned) {
    return jsonResponse({ error: "session_banned", anomalyScore: binding.session.anomalyScore }, 403);
  }

  const deltas = [];
  if (binding.anomalyDelta > 0)
    deltas.push({ delta: binding.anomalyDelta, reason: `session_binding (${binding.reasons.join(",")})` });

  // Honeypot check
  const honeypotTriggered = await checkHoneypot(env, sessionId, body);
  if (honeypotTriggered) {
    deltas.push({ delta: SCORE_DELTAS.honeypot_triggered, reason: "honeypot_filled" });
    await applyScoreDeltas(env, config, sessionId, deltas);
    await logRequest(env, { type: "honeypot_triggered", sessionId, ip });
    return jsonResponse({ error: "checkout_failed", reason: "validation_error" }, 400);
  }

  // CAPTCHA
  const captchaResult = await validateCaptcha(env, config, captchaChallenge, captchaSolution);
  if (!captchaResult.valid) {
    await logRequest(env, { type: "captcha_fail", reason: captchaResult.reason, sessionId, ip });
    return jsonResponse({ error: "captcha_failed", reason: captchaResult.reason }, 400);
  }

  // Token
  const tokenResult = await consumeCheckoutToken(env, checkoutToken, sessionId);
  if (!tokenResult.valid) {
    if (tokenResult.anomalyScore)
      deltas.push({ delta: tokenResult.anomalyScore, reason: `token_${tokenResult.reason}` });
    await applyScoreDeltas(env, config, sessionId, deltas);
    return jsonResponse({ error: tokenResult.reason }, 400);
  }

  // Behavioral timing
  await recordAction(env, sessionId, "checkout_complete", Date.now());
  const behResult = await analyzeSession(env, sessionId, config);
  if (behResult.suspicious) {
    deltas.push({ delta: SCORE_DELTAS.behavioral_flag, reason: `behavioral (${behResult.reasons.join(",")})` });
    await logRequest(env, { type: "behavioral_flag", reasons: behResult.reasons, sessionId, ip });
  }

  // Payment validation
  if (!payment?.card_number || !payment?.expiry || !payment?.cvv) {
    return jsonResponse({ error: "payment_invalid" }, 400);
  }

  // Race against the defender bots. The bots are simulated (they don't touch
  // the Durable Object), so before granting a human purchase we check the
  // EFFECTIVE pool = DO count − tickets the bot swarm has consumed by now.
  // If the bots have already drained it, the human is too late → sold out.
  const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
  const statusRes = await counterStub.fetch("http://do/counter", {
    method: "POST", body: JSON.stringify({ action: "status" }),
  });
  const { count: doCount, total } = await statusRes.json();
  const { totalBotTickets } = await getBotState(env, total, config, Date.now());
  const effectiveRemaining = doCount - totalBotTickets;

  if (effectiveRemaining < tokenResult.seats.length) {
    await logRequest(env, { type: "purchase_too_late", sessionId, ip, reason: "bots_drained_pool" });
    return jsonResponse({
      error: "sold_out",
      reason: "the defender bots grabbed the remaining tickets first",
      remaining: Math.max(0, effectiveRemaining),
    }, 409);
  }

  // Atomic ticket decrement
  const res = await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({
      action: "decrement",
      amount: tokenResult.seats.length,
      accountId: tokenResult.accountId,
    }),
  });
  const result = await res.json();

  if (!result.ok) {
    return jsonResponse({ error: result.reason, remaining: result.remaining }, 409);
  }

  const takenSeats = (await env.KV.get("taken_seats", "json")) || [];
  takenSeats.push(...tokenResult.seats);
  await env.KV.put("taken_seats", JSON.stringify(takenSeats), { expirationTtl: 86400 });

  if (deltas.length > 0) {
    await applyScoreDeltas(env, config, sessionId, deltas);
  }

  const session = await getSession(env, sessionId);
  await logRequest(env, {
    type: "purchase_success",
    sessionId,
    accountId: tokenResult.accountId,
    seats: tokenResult.seats,
    ip,
    remaining: result.remaining,
    anomalyScore: session?.anomalyScore ?? 0,
  });

  return jsonResponse({
    ok: true,
    confirmation: `CONF-${Date.now().toString(36).toUpperCase()}`,
    seats: tokenResult.seats,
    tickets_remaining: result.remaining,
    anomalyScore: session?.anomalyScore ?? 0,
  });
}

function eventInfo() {
  return {
    name: "TicketStorm Live — Sold Out Tour",
    venue: "The Concurrent Arena",
    date: "2025-12-31T21:00:00Z",
  };
}

function buildSeatMap(total, takenSeats) {
  if (!total) return [];
  const takenSet = new Set(takenSeats);
  const seats = [];
  for (let i = 1; i <= total; i++) {
    const row = String.fromCharCode(65 + Math.floor((i - 1) / 10));
    const col = ((i - 1) % 10) + 1;
    const id = `${row}${col}`;
    seats.push({ id, row, col, status: takenSet.has(id) ? "taken" : "available" });
  }
  return seats;
}
