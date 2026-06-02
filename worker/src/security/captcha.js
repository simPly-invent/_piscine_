/**
 * captcha.js — proof-of-work (PoW) CAPTCHA.
 *
 * WHY PROOF-OF-WORK?
 * Visual CAPTCHAs require an image pipeline and are easily defeated by ML.
 * PoW is simpler to deploy serverlessly and is genuinely bot-relevant: a
 * well-optimised bot can solve it faster than a human (by running it in a
 * Worker thread), but the CPU cost acts as a rate multiplier — at difficulty 5
 * (5 leading zeros) the expected work is 16^5 = ~1M hash iterations, which
 * costs ~100ms even on fast hardware, making mass-parallel requests expensive.
 *
 * PROTOCOL:
 *   1. Client hits GET /api/captcha → receives { challenge, zeros, expires_at }
 *   2. Client iterates nonces until SHA256(challenge + nonce) starts with `zeros` zeros
 *   3. Client sends { challenge, solution } with the checkout request
 *   4. Server verifies and marks the challenge as used (single-use, TTL-bound)
 *
 * CHALLENGER HINT:
 * You can solve PoW in a separate thread so it doesn't block your main loop.
 * At easy difficulty (2 zeros) a single SHA256 call in Node takes ~0.002ms —
 * expect ~600 iterations on average.
 */

import { randomToken, sha256hex, verifyPoW } from "../utils/crypto.js";

const CHALLENGE_TTL = 120; // seconds — client has 2 min to solve

export async function issueCaptcha(env, config) {
  if (!config.captcha_enabled) return null;

  const challenge = randomToken(16);
  const zeros = config.captcha_pow_zeros ?? 3;
  const expiresAt = Date.now() + CHALLENGE_TTL * 1000;

  await env.KV.put(
    `captcha:${challenge}`,
    JSON.stringify({ zeros, expiresAt, used: false }),
    { expirationTtl: CHALLENGE_TTL + 10 }
  );

  return { challenge, zeros, expires_at: expiresAt };
}

export async function validateCaptcha(env, config, challenge, solution) {
  if (!config.captcha_enabled) return { valid: true };

  if (!challenge || solution === undefined) {
    return { valid: false, reason: "captcha_missing" };
  }

  const stored = await env.KV.get(`captcha:${challenge}`, "json");
  if (!stored) return { valid: false, reason: "captcha_expired_or_unknown" };
  if (stored.used) return { valid: false, reason: "captcha_already_used" };
  if (Date.now() > stored.expiresAt) return { valid: false, reason: "captcha_expired" };

  const ok = await verifyPoW(challenge, String(solution), stored.zeros);
  if (!ok) return { valid: false, reason: "captcha_wrong_solution" };

  // Mark single-use
  await env.KV.put(
    `captcha:${challenge}`,
    JSON.stringify({ ...stored, used: true }),
    { expirationTtl: 60 }
  );

  return { valid: true };
}
