/**
 * token-rotation.js — short-lived, single-use checkout tokens.
 *
 * WHY SHORT TTL?
 * A long-lived checkout token lets a bot pre-fetch tokens in bulk and replay
 * them later.  At 30s TTL the bot must begin checkout and complete it within
 * the same window — it can't batch 100 tokens at once.
 *
 * WHY SINGLE-USE?
 * Without single-use enforcement a bot can retry the same token after a
 * transient error.  With it, every retry requires a fresh token + CAPTCHA.
 *
 * SESSION BINDING:
 * The token is cryptographically bound to the session that requested it
 * (stored in KV alongside the token).  If a different session tries to use it
 * → anomaly score increase.
 *
 * CHALLENGER HINT:
 * You must automate the full checkout pipeline: login → get event → init
 * checkout (get token + CAPTCHA challenge) → solve CAPTCHA → submit checkout
 * all within 30 seconds.  Parallelising across accounts is fine, but each
 * account needs its own pipeline.
 */

import { randomToken } from "../utils/crypto.js";

export async function issueCheckoutToken(env, config, sessionId, accountId, seats) {
  const token = randomToken(32);
  const ttl = config.checkout_token_ttl_seconds ?? 30;

  await env.KV.put(
    `ct:${token}`,
    JSON.stringify({
      sessionId,
      accountId,
      seats,
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
      used: false,
    }),
    { expirationTtl: ttl + 5 }
  );

  return { token, expires_in: ttl };
}

export async function consumeCheckoutToken(env, token, sessionId) {
  const stored = await env.KV.get(`ct:${token}`, "json");

  if (!stored) return { valid: false, reason: "token_not_found" };
  if (stored.used) return { valid: false, reason: "token_already_used" };
  if (Date.now() > stored.expiresAt) return { valid: false, reason: "token_expired" };

  // Session binding check — token must be redeemed by the same session
  if (stored.sessionId !== sessionId) {
    return { valid: false, reason: "token_session_mismatch", anomalyScore: 35 };
  }

  // Mark single-use immediately
  await env.KV.put(
    `ct:${token}`,
    JSON.stringify({ ...stored, used: true }),
    { expirationTtl: 10 }
  );

  return { valid: true, accountId: stored.accountId, seats: stored.seats };
}
