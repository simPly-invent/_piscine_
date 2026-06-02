/**
 * api.js — /api/status, /api/reset, /api/logs, /api/queue/status
 */

import { getLogs, clearLogs } from "../utils/logger.js";
import { initBotSchedule, getBotState } from "../bots/defender.js";
import { getConfig, setConfig, DEFAULTS } from "../config.js";
import { safeEqual } from "../utils/crypto.js";
import { jsonResponse, getIP, getSessionId } from "./shared.js";
import { checkQueue } from "../security/queue.js";
import { getSession } from "../security/session-binding.js";
import { issueCaptcha } from "../security/captcha.js";
import { issueHoneypotConfig } from "../security/honeypot.js";

export async function handleStatus(request, env, config) {
  const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
  const res = await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({ action: "status" }),
  });
  const { count, total, purchases } = await res.json();

  const sim = (await env.KV.get("simulation", "json")) || {};
  const nowMs = Date.now();

  // Compute bot state by replaying the pre-generated schedule
  const botState = await getBotState(env, total, config, nowMs);

  // Human purchases = total - remaining - bot purchases
  const humanPurchases = total - count - botState.totalBotTickets;

  return jsonResponse({
    simulation: {
      started_at: sim.startedAt,
      elapsed_ms: sim.startedAt ? nowMs - sim.startedAt : 0,
    },
    tickets: {
      total,
      remaining: count,
      taken: total - count,
      human_purchases: Math.max(0, humanPurchases),
      bot_purchases: botState.totalBotTickets,
    },
    config: {
      difficulty: config.difficulty,
      defender_bots: config.defender_bots_count,
      captcha_enabled: config.captcha_enabled,
    },
    bot_activity: Object.entries(botState.botAccounts)
      .filter(([, v]) => v.bought > 0)
      .slice(0, 20) // show up to 20 active bots
      .map(([id, v]) => ({ id: id.slice(0, 8) + "…", type: v.type, bought: v.bought })),
  });
}

export async function handleReset(request, env) {
  const body = await request.json().catch(() => ({}));
  const providedSecret = body.secret || request.headers.get("X-Reset-Secret") || "";
  const expectedSecret = env.RESET_SECRET || DEFAULTS.reset_secret;

  if (!safeEqual(providedSecret, expectedSecret)) {
    return jsonResponse({ error: "invalid_secret" }, 403);
  }

  const newConfig = { ...DEFAULTS, ...(body.config || {}) };
  await setConfig(env, newConfig);

  // Reset Durable Object counter
  const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
  await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({ action: "reset" }),
  });
  await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({ action: "init", amount: newConfig.tickets_total }),
  });
  await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({ action: "set_config", amount: newConfig.max_tickets_per_account }),
  });

  // Clear KV state
  await clearLogs(env);
  await env.KV.delete("taken_seats");
  await env.KV.delete("bot_schedule");

  // Generate fresh bot schedule
  const startedAt = Date.now();
  await env.KV.put("simulation", JSON.stringify({ startedAt }), {
    expirationTtl: newConfig.session_ttl_seconds + 300,
  });
  await initBotSchedule(env, newConfig, startedAt);

  return jsonResponse({ ok: true, message: "simulation reset", started_at: startedAt });
}

export async function handleLogs(request, env, config) {
  const logs = await getLogs(env);
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") || "100", 10);
  const type = url.searchParams.get("type");
  const filtered = type ? logs.filter((l) => l.type === type) : logs;
  return jsonResponse({ logs: filtered.slice(-limit), total: filtered.length });
}

export async function handleQueueStatus(request, env) {
  const sessionId = getSessionId(request) || new URL(request.url).searchParams.get("session");
  if (!sessionId) return jsonResponse({ error: "session_required" }, 400);
  const queue = await checkQueue(env, sessionId);
  return jsonResponse(queue);
}

export async function handleGetCaptcha(request, env, config) {
  const captcha = await issueCaptcha(env, config);
  if (!captcha) return jsonResponse({ enabled: false });
  return jsonResponse(captcha);
}

export async function handleGetHoneypot(request, env, config) {
  const sessionId = getSessionId(request);
  if (!sessionId) return jsonResponse({ error: "session_required" }, 400);
  const fields = await issueHoneypotConfig(env, sessionId);
  return jsonResponse({ fields });
}

export async function handleGetSession(request, env) {
  const sessionId = getSessionId(request);
  if (!sessionId) return jsonResponse({ error: "no_session" }, 400);
  const session = await getSession(env, sessionId);
  if (!session) return jsonResponse({ error: "session_not_found" }, 404);
  // Don't expose IP/UA of other users — only safe fields
  return jsonResponse({
    sessionId: session.sessionId,
    anomalyScore: session.anomalyScore,
    banned: session.banned,
    createdAt: session.createdAt,
  });
}
