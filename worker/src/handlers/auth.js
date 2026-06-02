/**
 * auth.js — account registration and login.
 *
 * Each account is stored in KV under `acc:{accountId}`.
 * Passwords are hashed with SHA-256 (educational simplicity — use bcrypt in prod).
 *
 * Per-IP account creation limit enforces `max_accounts_per_ip` from config.
 */

import { randomToken, sha256hex } from "../utils/crypto.js";
import { createSession } from "../security/session-binding.js";
import { logRequest } from "../utils/logger.js";
import { isDatacenterIP } from "../security/ip-reputation.js";
import { applyScoreDeltas, SCORE_DELTAS } from "../security/anomaly-score.js";
import { jsonResponse, getIP, getUA } from "./shared.js";

export async function handleRegister(request, env, config) {
  const ip = getIP(request);
  const ua = getUA(request);
  const body = await request.json().catch(() => ({}));
  const { username, email, password } = body;

  if (!username || !email || !password) {
    return jsonResponse({ error: "missing_fields" }, 400);
  }

  // IP reputation check
  if (isDatacenterIP(ip)) {
    await logRequest(env, { type: "register_blocked", reason: "datacenter_ip", ip });
    return jsonResponse({ error: "registration_blocked" }, 403);
  }

  // Per-IP account limit
  const ipAccountsKey = `ip_accs:${ip}`;
  const ipAccounts = (await env.KV.get(ipAccountsKey, "json")) || [];
  if (ipAccounts.length >= config.max_accounts_per_ip) {
    return jsonResponse({ error: "too_many_accounts_from_ip" }, 429);
  }

  // Account is keyed directly by email (one fewer KV write than a separate
  // email→id index). accountId stays as the salt + per-account purchase key.
  const emailLower = email.toLowerCase();
  const accKey = `acc:${emailLower}`;
  if (await env.KV.get(accKey)) {
    return jsonResponse({ error: "email_already_registered" }, 409);
  }

  const accountId = randomToken(16);
  const passwordHash = await sha256hex(password + accountId); // salt with accountId

  await env.KV.put(
    accKey,
    JSON.stringify({ accountId, username, email: emailLower, passwordHash, createdAt: Date.now() }),
    { expirationTtl: config.session_ttl_seconds * 2 }
  );
  ipAccounts.push(accountId);
  await env.KV.put(ipAccountsKey, JSON.stringify(ipAccounts), { expirationTtl: config.session_ttl_seconds });

  // Auto-login: create session
  const sessionId = randomToken(32);
  await createSession(env, config, sessionId, ip, ua, accountId);

  await logRequest(env, { type: "register", accountId, ip });
  return jsonResponse({ ok: true, accountId, sessionId }, 201);
}

export async function handleLogin(request, env, config) {
  const ip = getIP(request);
  const ua = getUA(request);
  const body = await request.json().catch(() => ({}));
  const { email, password } = body;

  if (!email || !password) return jsonResponse({ error: "missing_fields" }, 400);

  const account = await env.KV.get(`acc:${email.toLowerCase()}`, "json");
  if (!account) return jsonResponse({ error: "invalid_credentials" }, 401);

  const expectedHash = await sha256hex(password + account.accountId);
  if (account.passwordHash !== expectedHash) {
    return jsonResponse({ error: "invalid_credentials" }, 401);
  }

  const sessionId = randomToken(32);
  await createSession(env, config, sessionId, ip, ua, account.accountId);

  await logRequest(env, { type: "login", accountId: account.accountId, ip });
  return jsonResponse({ ok: true, accountId: account.accountId, sessionId });
}
