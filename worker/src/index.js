/**
 * index.js — Cloudflare Worker entry point and request router.
 */

export { TicketCounter } from "./durable-objects/ticket-counter.js";

import { getConfig } from "./config.js";
import { checkRateLimit } from "./security/rate-limiter.js";
import { isDatacenterIP } from "./security/ip-reputation.js";
import { applyScoreDeltas, SCORE_DELTAS } from "./security/anomaly-score.js";
import { handleRegister, handleLogin } from "./handlers/auth.js";
import { handleGetEvent, handleCheckoutInit, handleCheckoutComplete } from "./handlers/tickets.js";
import {
  handleStatus,
  handleReset,
  handleLogs,
  handleQueueStatus,
  handleGetCaptcha,
  handleGetHoneypot,
  handleGetSession,
  handleAdmin,
} from "./handlers/api.js";
import { handleScoreboard } from "./handlers/scoreboard.js";
import { logRequest } from "./utils/logger.js";
import { getIP, getUA, getSessionId, jsonResponse } from "./handlers/shared.js";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-FP, X-Reset-Secret",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    try {
      const config = await getConfig(env);
      const ip = getIP(request);
      const ua = getUA(request);
      const sessionId = getSessionId(request);
      const url = new URL(request.url);
      const path = url.pathname;

      // IP reputation check — exempt /api/reset so operator can always recover
      if (path !== "/api/reset" && isDatacenterIP(ip)) {
        ctx.waitUntil(logRequest(env, { type: "blocked_datacenter_ip", ip, path }));
        if (sessionId) {
          ctx.waitUntil(applyScoreDeltas(env, config, sessionId, [SCORE_DELTAS.datacenter_ip]));
        }
        return jsonResponse({ error: "forbidden", reason: "datacenter_ip" }, 403);
      }

      // Rate limiting — only on POST (mutations: register, login, checkout).
      // GET requests (browsing the event page, polling status) are reads and
      // must not be throttled, otherwise normal navigation gets 429'd. The
      // meaningful bot-abuse surface is the checkout/auth POSTs anyway.
      if (request.method === "POST") {
        const rateResult = await checkRateLimit(env, config, ip, sessionId);
        if (rateResult.blocked) {
          ctx.waitUntil(logRequest(env, { type: "rate_limited", ip, reason: rateResult.reason, path }));
          if (sessionId) {
            ctx.waitUntil(applyScoreDeltas(env, config, sessionId, [SCORE_DELTAS.rate_limit_violation]));
          }
          return jsonResponse({ error: "rate_limited", retry_after_ms: rateResult.retryAfterMs }, 429);
        }
      }

      // Routing
      if (path === "/api/auth/register" && request.method === "POST")
        return handleRegister(request, env, config);

      if (path === "/api/auth/login" && request.method === "POST")
        return handleLogin(request, env, config);

      if (path === "/api/event" && request.method === "GET")
        return handleGetEvent(request, env, config);

      if (path === "/api/checkout/init" && request.method === "POST")
        return handleCheckoutInit(request, env, config);

      if (path === "/api/checkout/complete" && request.method === "POST")
        return handleCheckoutComplete(request, env, config);

      if (path === "/api/captcha" && request.method === "GET")
        return handleGetCaptcha(request, env, config);

      if (path === "/api/honeypot" && request.method === "GET")
        return handleGetHoneypot(request, env, config);

      if (path === "/api/status" && request.method === "GET")
        return handleStatus(request, env, config);

      if (path === "/api/reset" && request.method === "POST")
        return handleReset(request, env);

      if (path === "/api/logs" && request.method === "GET")
        return handleLogs(request, env, config);

      if (path === "/api/queue/status" && request.method === "GET")
        return handleQueueStatus(request, env);

      if (path === "/api/session" && request.method === "GET")
        return handleGetSession(request, env);

      if (path === "/events/scoreboard")
        return handleScoreboard(request, env);

      if (path === "/api/admin" && request.method === "GET")
        return handleAdmin(request, env, config);

      return jsonResponse({ error: "not_found" }, 404);

    } catch (err) {
      console.error(err);
      return jsonResponse({ error: "internal_error", message: err.message }, 500);
    }
  },
};
