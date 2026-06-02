/**
 * behavioral.js — superhuman timing detection.
 *
 * WHAT WE MEASURE:
 * Each client-side action (page_load, seat_select, checkout_open, form_fill,
 * submit) sends a timestamp to the server.  We compare consecutive timestamps
 * and flag sessions where:
 *
 *   1. Any single step is faster than `min_action_ms` (default 200ms at medium).
 *      Humans need at least 150–200ms to perceive a UI change and react.
 *
 *   2. The coefficient of variation (stddev / mean) of all intervals is < 0.05.
 *      Perfect regularity is a bot signature — humans have biological jitter
 *      (muscle tremor, attention variation) that creates ~20–30% CV.
 *
 *   3. Total session duration is suspiciously short (< 3s for a full checkout).
 *
 * CHALLENGER HINT:
 * Add gaussian noise to your inter-request delays: pick a base delay, then add
 * `Math.random() * 0.3 * base` (30% jitter).  Clamp to the configured minimum.
 * A CV of ~0.25 looks human.  Also enforce the minimum per-step duration.
 */

export async function recordAction(env, sessionId, action, clientTs) {
  const key = `beh:${sessionId}`;
  const history = (await env.KV.get(key, "json")) || [];
  history.push({ action, clientTs, serverTs: Date.now() });
  await env.KV.put(key, JSON.stringify(history.slice(-20)), { expirationTtl: 3600 });
}

export async function analyzeSession(env, sessionId, config) {
  const history = (await env.KV.get(`beh:${sessionId}`, "json")) || [];
  if (history.length < 2) return { suspicious: false, score: 0 };

  const intervals = [];
  for (let i = 1; i < history.length; i++) {
    intervals.push(history[i].serverTs - history[i - 1].serverTs);
  }

  const minInterval = Math.min(...intervals);
  const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const stddev = Math.sqrt(
    intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length
  );
  const cv = mean > 0 ? stddev / mean : 0;

  const minMs = config.behavioral_min_action_ms ?? 200;
  let score = 0;
  const reasons = [];

  if (minInterval < minMs) {
    score += 25;
    reasons.push(`step_too_fast_${minInterval}ms`);
  }
  if (intervals.length >= 4 && cv < 0.05) {
    score += 20;
    reasons.push(`robotic_timing_cv_${cv.toFixed(3)}`);
  }
  const totalMs = history[history.length - 1].serverTs - history[0].serverTs;
  if (history.length >= 4 && totalMs < 3000) {
    score += 15;
    reasons.push(`session_too_fast_${totalMs}ms`);
  }

  return { suspicious: score > 0, score, reasons };
}
