/**
 * tickets.js — event info, seat map, checkout initiation and completion.
 *
 * CHECKOUT FLOW:
 *   1. GET  /api/event           → event details + available seat list
 *   2. POST /api/checkout/init   → get checkout token + CAPTCHA challenge
 *      Body: { sessionId, seats: [seatId, ...] }
 *   3. POST /api/checkout/complete → buy the tickets
 *      Body: { sessionId, checkoutToken, captchaChallenge, captchaSolution, payment }
 *
 * Every step goes through the full security pipeline.  Any failed check
 * increases the anomaly score.
 */

import { issueCheckoutToken, consumeCheckoutToken } from "../security/token-rotation.js";
import { issueCaptcha, validateCaptcha } from "../security/captcha.js";
import { checkHoneypot } from "../security/honeypot.js";
import { analyzeSession, recordAction } from "../security/behavioral.js";
import { checkFingerprint } from "../security/fingerprint.js";
import { validateSessionBinding, getSession, updateAnomalyScore } from "../security/session-binding.js";
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

  const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
  const res = await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({ action: "status" }),
  });
  const { count, total } = await res.json();

  // Build a 10×10 seat grid.  Taken seats are stored as a set in KV.
  const takenSeats = (await env.KV.get("taken_seats", "json")) || [];
  const seats = buildSeatMap(total, takenSeats);

  return jsonResponse({
    event: {
      name: "TicketStorm Live — Sold Out Tour",
      venue: "The Concurrent Arena",
      date: "2025-12-31T21:00:00Z",
    },
    tickets_remaining: count,
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

  const session = binding.session;
  if (session.banned) return jsonResponse({ error: "session_banned", anomalyScore: session.anomalyScore }, 403);

  // Queue check
  const queue = await checkQueue(env, sessionId);
  if (!queue.admitted) {
    return jsonResponse({ queued: true, waitMs: queue.waitMs });
  }

  const deltas = [];
  if (binding.anomalyDelta > 0) deltas.push(binding.anomalyDelta);

  // Fingerprint check
  const fpResult = await checkFingerprint(env, config, sessionId, canvasFingerprint, request);
  if (fpResult.score > 0) deltas.push(fpResult.score);

  // Behavioral analysis
  await recordAction(env, sessionId, "checkout_init", Date.now());
  const behResult = await analyzeSession(env, sessionId, config);
  if (behResult.suspicious) deltas.push(SCORE_DELTAS.behavioral_flag);

  if (deltas.length > 0) {
    const scoreResult = await applyScoreDeltas(env, config, sessionId, deltas);
    if (scoreResult?.banned) {
      return jsonResponse({ error: "session_banned", anomalyScore: scoreResult.anomalyScore }, 403);
    }
  }

  const { token, expires_in } = await issueCheckoutToken(env, config, sessionId, session.accountId, seats);
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

  // Session binding
  const binding = await validateSessionBinding(env, sessionId, ip, ua);
  if (!binding.valid) return jsonResponse({ error: binding.reason }, 401);
  if (binding.session.banned) {
    return jsonResponse({ error: "session_banned", anomalyScore: binding.session.anomalyScore }, 403);
  }

  const deltas = [];
  if (binding.anomalyDelta > 0) deltas.push(binding.anomalyDelta);

  // Honeypot check
  const honeypotTriggered = await checkHoneypot(env, sessionId, body);
  if (honeypotTriggered) {
    deltas.push(SCORE_DELTAS.honeypot_triggered);
    await applyScoreDeltas(env, config, sessionId, deltas);
    await logRequest(env, { type: "honeypot", sessionId, ip });
    return jsonResponse({ error: "checkout_failed" }, 400);
  }

  // CAPTCHA validation
  const captchaResult = await validateCaptcha(env, config, captchaChallenge, captchaSolution);
  if (!captchaResult.valid) {
    await logRequest(env, { type: "captcha_fail", reason: captchaResult.reason, sessionId, ip });
    return jsonResponse({ error: "captcha_failed", reason: captchaResult.reason }, 400);
  }

  // Token consumption (single-use, TTL, session binding)
  const tokenResult = await consumeCheckoutToken(env, checkoutToken, sessionId);
  if (!tokenResult.valid) {
    if (tokenResult.anomalyScore) deltas.push(tokenResult.anomalyScore);
    await applyScoreDeltas(env, config, sessionId, deltas);
    return jsonResponse({ error: tokenResult.reason }, 400);
  }

  // Behavioral timing check
  await recordAction(env, sessionId, "checkout_complete", Date.now());
  const behResult = await analyzeSession(env, sessionId, config);
  if (behResult.suspicious) deltas.push(SCORE_DELTAS.behavioral_flag);

  // Payment validation (fake but required)
  if (!payment || !payment.card_number || !payment.expiry || !payment.cvv) {
    return jsonResponse({ error: "payment_invalid" }, 400);
  }

  // Atomic ticket decrement via Durable Object
  const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
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

  // Update taken seats in KV
  const takenSeats = (await env.KV.get("taken_seats", "json")) || [];
  takenSeats.push(...tokenResult.seats);
  await env.KV.put("taken_seats", JSON.stringify(takenSeats));

  // Apply any accumulated anomaly score
  if (deltas.length > 0) {
    await applyScoreDeltas(env, config, sessionId, deltas);
  }

  const session = await getSession(env, sessionId);
  await logRequest(env, {
    type: "purchase",
    sessionId,
    accountId: tokenResult.accountId,
    seats: tokenResult.seats,
    ip,
    remaining: result.remaining,
  });

  return jsonResponse({
    ok: true,
    confirmation: `CONF-${Date.now().toString(36).toUpperCase()}`,
    seats: tokenResult.seats,
    tickets_remaining: result.remaining,
    anomalyScore: session?.anomalyScore ?? 0,
  });
}

function buildSeatMap(total, takenSeats) {
  const takenSet = new Set(takenSeats);
  const seats = [];
  for (let i = 1; i <= total; i++) {
    const row = String.fromCharCode(65 + Math.floor((i - 1) / 10));
    const col = ((i - 1) % 10) + 1;
    seats.push({
      id: `${row}${col}`,
      row,
      col,
      status: takenSet.has(`${row}${col}`) ? "taken" : "available",
    });
  }
  return seats;
}
