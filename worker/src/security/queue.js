/**
 * queue.js — virtual waiting room with randomized admission delay.
 *
 * HOW IT WORKS:
 * When a session first hits the event page, it is assigned a queue position
 * and a computed admission time.  Until that time, the frontend shows a
 * "you're in the queue" spinner.  After admission, a queue token is issued
 * that must accompany all checkout requests.
 *
 * WHY RANDOMISE THE DELAY?
 * A fixed delay lets a bot pre-compute exactly when to start pipelining.
 * Randomisation forces the bot to poll `/api/queue/status` and react — adding
 * real latency overhead and making it harder to time the checkout pipeline.
 *
 * DIFFICULTY SCALING:
 *   easy      → no queue (pass-through)
 *   medium    → 2–8 s wait
 *   hard      → 5–20 s wait
 *   nightmare → 10–45 s wait
 *
 * CHALLENGER HINT:
 * Poll `/api/queue/status?session=X` and proceed only when `admitted=true`.
 * Your bot must be able to begin checkout immediately on admission — any delay
 * after the queue releases you burns precious seconds before the pool empties.
 */

const QUEUE_DELAYS = {
  easy: [0, 0],
  medium: [2000, 8000],
  hard: [5000, 20000],
  nightmare: [10000, 45000],
};

export async function enqueue(env, config, sessionId) {
  // easy mode: no queue
  const [minMs, maxMs] = QUEUE_DELAYS[config.difficulty] || [0, 0];
  if (minMs === 0 && maxMs === 0) {
    return { queued: false, admitted: true };
  }

  const existing = await env.KV.get(`queue:${sessionId}`, "json");
  if (existing) return existing;

  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const admitAt = Date.now() + delay;
  const entry = { queued: true, admitted: false, admitAt, delay };
  await env.KV.put(`queue:${sessionId}`, JSON.stringify(entry), { expirationTtl: 120 });
  return entry;
}

export async function checkQueue(env, sessionId) {
  const entry = await env.KV.get(`queue:${sessionId}`, "json");
  if (!entry) return { admitted: true }; // session not in queue → admit

  if (entry.admitted) return entry;

  if (Date.now() >= entry.admitAt) {
    const updated = { ...entry, admitted: true };
    await env.KV.put(`queue:${sessionId}`, JSON.stringify(updated), { expirationTtl: 120 });
    return updated;
  }

  return { ...entry, waitMs: entry.admitAt - Date.now() };
}
