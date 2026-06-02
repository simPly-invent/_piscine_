/**
 * api.js — /api/status, /api/reset, /api/logs, /api/queue/status,
 *           /api/admin (config panel), /api/anomaly/:sessionId
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
import { _resetRateLimiterMemory } from "../security/rate-limiter.js";

/**
 * Delete every KV key matching any of the given prefixes. Paginates through
 * KV.list() (1000 keys/page) until exhausted. Used by reset for a clean slate.
 */
async function clearByPrefixes(env, prefixes) {
  for (const prefix of prefixes) {
    let cursor;
    do {
      const list = await env.KV.list({ prefix, cursor });
      await Promise.all(list.keys.map(k => env.KV.delete(k.name)));
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }
}

export async function handleStatus(request, env, config) {
  let count = 0, total = 0, purchases = {};
  try {
    const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
    const res = await counterStub.fetch("http://do/counter", {
      method: "POST",
      body: JSON.stringify({ action: "status" }),
    });
    ({ count, total, purchases } = await res.json());
  } catch (_) {}

  const sim = (await env.KV.get("simulation", "json")) || {};
  const nowMs = Date.now();
  const botState = await getBotState(env, total, config, nowMs);

  // The Durable Object counter only tracks REAL (human) purchases — bots are
  // simulated and never touch it. So human purchases = total − DO count.
  // Bot purchases are tracked separately. Effective remaining = count − bots.
  const humanPurchases = Math.max(0, total - count);
  const elapsed = sim.startedAt ? nowMs - sim.startedAt : 0;
  const timeLeft = sim.startedAt
    ? Math.max(0, config.session_ttl_seconds * 1000 - elapsed)
    : 0;

  return jsonResponse({
    simulation: {
      started_at: sim.startedAt,
      elapsed_ms: elapsed,
      time_left_ms: timeLeft,
      active: !!sim.startedAt,
    },
    tickets: {
      total,
      remaining: Math.max(0, count - botState.totalBotTickets),
      taken_by_humans: humanPurchases,
      taken_by_bots: botState.totalBotTickets,
      sold_out: count === 0,
    },
    config: {
      difficulty: config.difficulty,
      defender_bots: config.defender_bots_count,
      captcha_enabled: config.captcha_enabled,
      captcha_pow_zeros: config.captcha_pow_zeros,
      fingerprinting_enabled: config.fingerprinting_enabled,
      rate_limit_rps: config.rate_limit_requests_per_second,
      anomaly_ban_threshold: config.anomaly_ban_threshold,
      checkout_token_ttl: config.checkout_token_ttl_seconds,
    },
    bot_activity: Object.entries(botState.botAccounts)
      .filter(([, v]) => v.bought > 0)
      .slice(0, 30)
      .map(([id, v]) => ({ id: id.slice(0, 10) + "…", type: v.type, bought: v.bought })),
    // Per-account purchases for scoreboard
    human_accounts: Object.entries(purchases)
      .filter(([id]) => !id.startsWith("bot_"))
      .map(([id, count]) => ({ id: id.slice(0, 10) + "…", bought: count })),
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

  const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
  await counterStub.fetch("http://do/counter", {
    method: "POST", body: JSON.stringify({ action: "reset" }),
  });
  await counterStub.fetch("http://do/counter", {
    method: "POST", body: JSON.stringify({ action: "init", amount: newConfig.tickets_total }),
  });
  await counterStub.fetch("http://do/counter", {
    method: "POST", body: JSON.stringify({ action: "set_config", amount: newConfig.max_tickets_per_account }),
  });

  await clearLogs(env);
  await env.KV.delete("taken_seats");
  await env.KV.delete("bot_schedule");

  // Wipe ALL per-player state so a reset is a true clean slate: sessions (and
  // their anomaly scores / bans), rate-limit windows, behavioral history,
  // fingerprints, honeypot configs, and per-IP account counters. Without this,
  // a session that got banned in a previous run stays banned after reset.
  await clearByPrefixes(env, ["sess:", "rl:", "beh:", "fp:", "hp:", "ip_accs:", "captcha:", "ct:", "queue:", "acc:", "email:"]);
  _resetRateLimiterMemory();

  const startedAt = Date.now();
  await env.KV.put("simulation", JSON.stringify({ startedAt }), {
    expirationTtl: newConfig.session_ttl_seconds + 300,
  });
  await initBotSchedule(env, newConfig, startedAt);

  return jsonResponse({
    ok: true,
    message: "simulation reset",
    started_at: startedAt,
    config: newConfig,
  });
}

/**
 * POST /api/admin/reset-ip — clears the "profile" of an IP so you can keep
 * testing without a full simulation reset. Wipes:
 *   - rate-limit windows (in-memory + KV) for that IP
 *   - the per-IP account creation counter (ip_accs:{ip})
 *   - if a sessionId is given: resets its anomaly score to 0 and unbans it
 *
 * Body: { secret, ip?, sessionId? }   (ip defaults to the caller's IP)
 */
export async function handleResetIp(request, env, config) {
  const body = await request.json().catch(() => ({}));
  const providedSecret = body.secret || request.headers.get("X-Reset-Secret") || "";
  const expectedSecret = env.RESET_SECRET || DEFAULTS.reset_secret;
  if (!safeEqual(providedSecret, expectedSecret)) {
    return jsonResponse({ error: "invalid_secret" }, 403);
  }

  const ip = body.ip || getIP(request);
  const cleared = [];

  // 1. Per-IP account creation counter
  await env.KV.delete(`ip_accs:${ip}`);
  cleared.push(`ip_accs:${ip}`);

  // 2. Rate-limit window for this IP (KV side)
  await env.KV.delete(`rl:ip:${ip}`);
  cleared.push(`rl:ip:${ip}`);

  // 3. In-memory rate-limit windows (clears all — they rebuild instantly)
  _resetRateLimiterMemory();
  cleared.push("in-memory rate windows");

  // 4. Optionally reset a session's anomaly score + ban
  let sessionReset = null;
  if (body.sessionId) {
    const session = await env.KV.get(`sess:${body.sessionId}`, "json");
    if (session) {
      const updated = { ...session, anomalyScore: 0, banned: false };
      await env.KV.put(`sess:${body.sessionId}`, JSON.stringify(updated), {
        expirationTtl: config.session_ttl_seconds,
      });
      // Also clear that session's rate-limit + behavioral history
      await env.KV.delete(`rl:acc:${body.sessionId}`);
      await env.KV.delete(`beh:${body.sessionId}`);
      sessionReset = { sessionId: body.sessionId, anomalyScore: 0, banned: false };
      cleared.push(`session ${body.sessionId.slice(0, 10)}… (score reset, unbanned)`);
    }
  }

  return jsonResponse({ ok: true, ip, cleared, sessionReset });
}

export async function handleLogs(request, env, config) {
  const logs = await getLogs(env);
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 500);
  const type = url.searchParams.get("type");
  const filtered = type ? logs.filter(l => l.type === type) : logs;

  // Aggregate stats
  const stats = filtered.reduce((acc, l) => {
    acc[l.type] = (acc[l.type] || 0) + 1;
    return acc;
  }, {});

  return jsonResponse({
    logs: filtered.slice(-limit).reverse(), // newest first
    total: filtered.length,
    stats,
  });
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
  return jsonResponse({
    sessionId: session.sessionId,
    anomalyScore: session.anomalyScore,
    banned: session.banned,
    createdAt: session.createdAt,
  });
}

/** GET /api/admin — returns full config + live stats (protected by reset secret) */
export async function handleAdmin(request, env, config) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || request.headers.get("X-Reset-Secret") || "";
  const expectedSecret = env.RESET_SECRET || DEFAULTS.reset_secret;
  if (!safeEqual(secret, expectedSecret)) {
    return jsonResponse({ error: "invalid_secret" }, 403);
  }
  return jsonResponse({
    config,
    difficulty_presets: ["easy", "medium", "hard", "nightmare"],
  });
}
