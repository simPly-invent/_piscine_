/**
 * logger.js — append-only request log stored in KV.
 *
 * Logs are kept in a ring buffer of up to MAX_ENTRIES.  Older entries are
 * evicted so KV storage stays bounded.  Each entry is a compact JSON object
 * so the /api/logs endpoint can return structured data for analysis.
 */

const LOG_KEY = "request_logs";
const MAX_ENTRIES = 500;

export async function logRequest(env, entry) {
  // Fire-and-forget — don't block the response on logging
  const logs = (await env.KV.get(LOG_KEY, "json")) || [];
  logs.push({
    ts: Date.now(),
    ...entry,
  });
  // Trim to ring buffer size
  const trimmed = logs.slice(-MAX_ENTRIES);
  // expirationTtl keeps KV tidy if the simulation is never reset
  await env.KV.put(LOG_KEY, JSON.stringify(trimmed), { expirationTtl: 86400 });
}

export async function getLogs(env) {
  return (await env.KV.get(LOG_KEY, "json")) || [];
}

export async function clearLogs(env) {
  await env.KV.delete(LOG_KEY);
}
