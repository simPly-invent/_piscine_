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
  difficulty: "medium",
  session_ttl_seconds: 1800,
  checkout_token_ttl_seconds: 30,
  rate_limit_requests_per_second: 10,
  captcha_enabled: true,
  fingerprinting_enabled: true,
  reset_secret: "changeme",
};

// Per-difficulty overrides.  Higher difficulty = tighter limits + more bots.
const DIFFICULTY_OVERRIDES = {
  easy: {
    rate_limit_requests_per_second: 20,
    defender_bots_count: 5,
    captcha_enabled: false,
    fingerprinting_enabled: false,
    anomaly_ban_threshold: 80,
    behavioral_min_action_ms: 100,
    captcha_pow_zeros: 2,
  },
  medium: {
    rate_limit_requests_per_second: 10,
    defender_bots_count: 20,
    captcha_enabled: true,
    fingerprinting_enabled: true,
    anomaly_ban_threshold: 70,
    behavioral_min_action_ms: 200,
    captcha_pow_zeros: 3,
  },
  hard: {
    rate_limit_requests_per_second: 5,
    defender_bots_count: 50,
    captcha_enabled: true,
    fingerprinting_enabled: true,
    anomaly_ban_threshold: 60,
    behavioral_min_action_ms: 300,
    captcha_pow_zeros: 4,
  },
  nightmare: {
    rate_limit_requests_per_second: 2,
    defender_bots_count: 200,
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
