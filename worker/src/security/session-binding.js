/**
 * session-binding.js — bind session tokens to IP + User-Agent at creation.
 *
 * WHY THIS MATTERS:
 * Without binding, a bot can create one session on a cheap residential proxy,
 * extract the token, and replay it from a fast datacenter IP.  Binding forces
 * the same proxy to be used for the entire checkout — increasing cost and
 * latency for the attacker.
 *
 * BINDING ATTRIBUTES:
 *   - IP address (exact match)
 *   - User-Agent string (exact match)
 *
 * A mismatch on any attribute adds to the anomaly score and, above a threshold,
 * invalidates the session entirely.
 *
 * CHALLENGER HINT:
 * Your HTTP client must send the exact same User-Agent string on every request
 * within a session.  Most HTTP libraries allow setting this; make sure you
 * don't accidentally send the library's default UA on some requests.
 */

export async function createSession(env, config, sessionId, ip, userAgent, accountId = null) {
  const session = {
    sessionId,
    ip,
    userAgent,
    accountId,
    createdAt: Date.now(),
    anomalyScore: 0,
    banned: false,
  };
  await env.KV.put(`sess:${sessionId}`, JSON.stringify(session), {
    expirationTtl: config.session_ttl_seconds,
  });
  return session;
}

export async function getSession(env, sessionId) {
  return env.KV.get(`sess:${sessionId}`, "json");
}

export async function validateSessionBinding(env, sessionId, ip, userAgent) {
  const session = await env.KV.get(`sess:${sessionId}`, "json");
  if (!session) return { valid: false, reason: "session_not_found" };
  if (session.banned) return { valid: false, reason: "session_banned" };

  let anomalyDelta = 0;
  const reasons = [];

  if (session.ip !== ip) {
    anomalyDelta += 35;
    reasons.push(`ip_changed_${session.ip}_to_${ip}`);
  }
  if (session.userAgent !== userAgent) {
    anomalyDelta += 20;
    reasons.push("user_agent_changed");
  }

  return { valid: true, anomalyDelta, reasons, session };
}

export async function updateAnomalyScore(env, config, sessionId, delta) {
  const session = await env.KV.get(`sess:${sessionId}`, "json");
  if (!session) return null;

  const newScore = Math.min(100, session.anomalyScore + delta);
  const threshold = config.anomaly_ban_threshold ?? 70;
  const banned = newScore >= threshold;

  const updated = { ...session, anomalyScore: newScore, banned };
  await env.KV.put(`sess:${sessionId}`, JSON.stringify(updated), {
    expirationTtl: config.session_ttl_seconds,
  });

  return { anomalyScore: newScore, banned };
}
