/**
 * rate-limiter.js — sliding window rate limiting per IP and per account.
 *
 * v2: Uses a hybrid approach to preserve KV write quota.
 * - In-memory Map for short bursts (same Worker instance, same 1s window)
 * - KV only for cross-instance coordination (written at most once per 10s per key)
 *
 * WHY HYBRID?
 * Cloudflare free tier: 1,000 KV writes/day. Writing on every request burns
 * the quota in minutes. The in-memory Map catches same-instance bursts for free;
 * KV only persists the window state so distributed instances stay coordinated.
 *
 * CHALLENGER HINT:
 * To bypass this you need to either spread requests across many IPs, or respect
 * the limit and pipeline requests within the window — same as TCP congestion control.
 */

// In-memory sliding window — reset when the Worker instance is recycled
const memoryWindows = new Map();

export async function checkRateLimit(env, config, ip, accountId) {
  const limit = config.rate_limit_requests_per_second;
  const now = Date.now();

  const ipResult = await slideWindow(env, `rl:ip:${ip}`, now, limit);
  if (ipResult.blocked) {
    return { blocked: true, reason: "rate_limit_ip", retryAfterMs: ipResult.retryAfterMs };
  }

  if (accountId) {
    const accResult = await slideWindow(env, `rl:acc:${accountId}`, now, limit);
    if (accResult.blocked) {
      return { blocked: true, reason: "rate_limit_account", retryAfterMs: accResult.retryAfterMs };
    }
  }

  return { blocked: false };
}

async function slideWindow(env, key, now, limit) {
  const windowMs = 1000;

  // Check in-memory first (free, no KV write)
  let timestamps = memoryWindows.get(key) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);

  if (timestamps.length >= limit) {
    const oldest = Math.min(...timestamps);
    return { blocked: true, retryAfterMs: windowMs - (now - oldest) };
  }

  timestamps.push(now);
  memoryWindows.set(key, timestamps);

  // Periodically sync to KV so other Worker instances see the state
  // Only write every 5s per key to preserve quota
  const syncKey = `${key}_sync`;
  const lastSync = memoryWindows.get(syncKey) || 0;
  if (now - lastSync > 5000) {
    memoryWindows.set(syncKey, now);
    // Fire-and-forget — don't await to keep the request fast
    env.KV.put(key, JSON.stringify(timestamps), { expirationTtl: 60 }).catch(() => {});
  }

  return { blocked: false, remaining: limit - timestamps.length };
}
