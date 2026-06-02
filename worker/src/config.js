/**
 * config.js — loads and validates simulation configuration.
 *
 * Config is stored in KV under the key "config" so it can be changed at
 * runtime via /api/reset without redeploying the worker.  The defaults below
 * are used when no KV value exists (first boot or after a hard reset).
 */

export const DEFAULTS = {
  tickets_total: 100,
  max_tickets_per_account: 2,
  max_accounts_per_ip: 3,
  defender_bots_count: 20,
  difficulty: "easy",
  session_ttl_seconds: 1800,
  checkout_token_ttl_seconds: 30,
  rate_limit_requests_per_second: 10,
  captcha_enabled: true,
  fingerprinting_enabled: true,
  reset_secret: "changeme",
};

// Per-difficulty overrides.  Higher difficulty = tighter limits + more bots.
//
// KEY DESIGN: defender_bots_count is sized so the bots CAN drain the entire
// pool (count × max_tickets_per_account >= tickets_total). Whether they
// actually do depends on `bot_drain_seconds` — the time the collective bot
// swarm takes to empty the pool if the human does nothing.
//   easy      → ~10 min: plenty of time to study and react
//   medium    → ~3 min
//   hard      → ~45 s: must be fast and automated
//   nightmare → ~12 s: only a perfectly optimised bot can grab anything
//
// clumsy_fail_rate is the fraction of bot attempts that deliberately fail
// (CAPTCHA miss) — this is the imperfection that gives a sharp human a gap.
const DIFFICULTY_OVERRIDES = {
  easy: {
    rate_limit_requests_per_second: 20,
    defender_bots_count: 60,        // 60×2 = 120 > 100 → can drain everything
    bot_drain_seconds: 600,         // …but slowly: 10 min
    clumsy_fail_rate: 0.35,
    captcha_enabled: false,
    fingerprinting_enabled: false,
    anomaly_ban_threshold: 80,
    behavioral_min_action_ms: 100,
    captcha_pow_zeros: 2,
  },
  medium: {
    rate_limit_requests_per_second: 10,
    defender_bots_count: 90,
    bot_drain_seconds: 180,         // 3 min
    clumsy_fail_rate: 0.25,
    captcha_enabled: true,
    fingerprinting_enabled: true,
    anomaly_ban_threshold: 70,
    behavioral_min_action_ms: 200,
    captcha_pow_zeros: 3,
  },
  hard: {
    rate_limit_requests_per_second: 5,
    defender_bots_count: 160,
    bot_drain_seconds: 45,          // 45 s
    clumsy_fail_rate: 0.15,
    captcha_enabled: true,
    fingerprinting_enabled: true,
    anomaly_ban_threshold: 60,
    behavioral_min_action_ms: 300,
    captcha_pow_zeros: 4,
  },
  nightmare: {
    rate_limit_requests_per_second: 2,
    defender_bots_count: 350,       // massively over-provisioned
    bot_drain_seconds: 12,          // pool gone in 12 s
    clumsy_fail_rate: 0.05,
    captcha_enabled: true,
    fingerprinting_enabled: true,
    anomaly_ban_threshold: 30,
    behavioral_min_action_ms: 500,
    captcha_pow_zeros: 5,
  },
};

export async function getConfig(env) {
  const stored = await env.KV.get("config", "json");
  const base = { ...DEFAULTS, ...(stored || {}) };
  const overrides = DIFFICULTY_OVERRIDES[base.difficulty] || DIFFICULTY_OVERRIDES.medium;
  return { ...base, ...overrides };
}

export async function setConfig(env, partial) {
  const current = await env.KV.get("config", "json") || {};
  await env.KV.put("config", JSON.stringify({ ...current, ...partial }));
}
