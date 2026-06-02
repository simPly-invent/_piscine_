/**
 * anomaly-score.js — composite scoring pipeline.
 *
 * Aggregates signals from all other security layers into a single 0–100 score
 * for the session.  Each layer contributes a delta.  Score accumulates over the
 * session lifetime and is never reset — so a bot that triggers one small signal
 * repeatedly will eventually hit the ban threshold.
 *
 * SCORE MAP:
 *   Layer                 | Delta per trigger
 *   ----------------------|------------------
 *   Rate limit violation  | +20
 *   Honeypot triggered    | +40
 *   Behavioral flag       | +25  (per flag)
 *   Fingerprint mismatch  | +30
 *   IP reputation (DC)    | +50
 *   Session binding fail  | +35
 *   Token session mismatch| +35
 *
 * BAN THRESHOLDS (configurable):
 *   easy      → 80
 *   medium    → 70
 *   hard      → 60
 *   nightmare → 30
 *
 * CHALLENGER HINT:
 * The scoreboard shows your real-time anomaly score.  Start at easy difficulty
 * and learn which actions trigger score increases before attempting harder modes.
 * A well-written bot keeps the score < 50 by mimicking human timing, using
 * residential IPs, and solving CAPTCHAs properly.
 */

export const SCORE_DELTAS = {
  rate_limit_violation: 20,
  honeypot_triggered: 40,
  behavioral_flag: 25,
  fingerprint_mismatch: 30,
  datacenter_ip: 50,
  session_binding_fail: 35,
  token_session_mismatch: 35,
};

import { updateAnomalyScore } from "./session-binding.js";

/**
 * Apply multiple score deltas at once and return the new score.
 * Returns null if the session doesn't exist.
 */
/**
 * Apply score deltas. Each entry can be a plain number, or a labelled
 * { delta, reason } object so the scoreboard can show what flagged the player.
 */
export async function applyScoreDeltas(env, config, sessionId, deltas) {
  if (!deltas || deltas.length === 0) return null;
  let total = 0;
  const reasons = [];
  for (const d of deltas) {
    if (typeof d === "number") { total += d; reasons.push(`+${d}`); }
    else { total += d.delta; reasons.push(`${d.reason} (+${d.delta})`); }
  }
  return updateAnomalyScore(env, config, sessionId, total, reasons);
}
