/**
 * rate-limiter.js — sliding window rate limiting per IP and per account.
 *
 * HOW IT WORKS:
 * We store a list of request timestamps in KV for each key (IP or account ID).
 * On each request we:
 *   1. Fetch the list and discard timestamps older than 1 second (the window).
 *   2. If the remaining count >= limit → block.
 *   3. Otherwise append the current timestamp and save.
 *
 * WHY SLIDING vs FIXED WINDOW:
 * A fixed window (reset every second) allows a burst of 2× the limit right
 * at the boundary — e.g. 10 requests at 0.99s + 10 at 1.01s = 20 in 0.02s.
 * The sliding window sees all 20 within a 1-second span and blocks correctly.
 *
 * CHALLENGER HINT:
 * To bypass this you need to either (a) spread requests across many IPs, or
 * (b) respect the limit and pipeline requests cleverly to saturate the window
 * without triggering it — same as TCP congestion control.
 */

export async function checkRateLimit(env, config, ip, accountId) {
  const limit = config.rate_limit_requests_per_second;
  const now = Date.now();
  const windowMs = 1000;

  // Check IP-level limit
  const ipResult = await slideWindow(env, `rl:ip:${ip}`, now, windowMs, limit);
  if (ipResult.blocked) {
    return { blocked: true, reason: "rate_limit_ip", retryAfterMs: ipResult.retryAfterMs };
  }

  // Check per-account limit (only if authenticated)
  if (accountId) {
    const accResult = await slideWindow(
      env,
      `rl:acc:${accountId}`,
      now,
      windowMs,
      limit
    );
    if (accResult.blocked) {
      return { blocked: true, reason: "rate_limit_account", retryAfterMs: accResult.retryAfterMs };
    }
  }

  return { blocked: false };
}

async function slideWindow(env, key, now, windowMs, limit) {
  const raw = await env.KV.get(key, "json");
  const timestamps = (raw || []).filter((t) => now - t < windowMs);

  if (timestamps.length >= limit) {
    // Earliest timestamp in the window tells the client how long to wait
    const oldest = Math.min(...timestamps);
    const retryAfterMs = windowMs - (now - oldest);
    return { blocked: true, retryAfterMs };
  }

  timestamps.push(now);
  // TTL slightly longer than the window so KV auto-cleans up
  await env.KV.put(key, JSON.stringify(timestamps), { expirationTtl: 10 });
  return { blocked: false, remaining: limit - timestamps.length };
}
