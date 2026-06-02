/**
 * rate-limiter.test.js
 *
 * Tests the sliding-window rate limiter.
 * Key properties:
 *   - Requests within the limit pass through.
 *   - The (limit+1)th request in the same second is blocked.
 *   - After the window slides past, requests pass again.
 *   - IP and account limits are checked independently.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit } from "../worker/src/security/rate-limiter.js";

// KV mock with real timestamps
function makeKV() {
  const store = new Map();
  return {
    get: async (key, type) => {
      const val = store.get(key);
      if (val === undefined) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    put: async (key, value, _opts) => {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    delete: async (key) => store.delete(key),
    _store: store,
  };
}

const BASE_CONFIG = { rate_limit_requests_per_second: 5 };

describe("checkRateLimit — IP level", () => {
  it("allows requests up to the limit", async () => {
    const kv = makeKV();
    const env = { KV: kv };
    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimit(env, BASE_CONFIG, "1.2.3.4", null);
      expect(result.blocked).toBe(false);
    }
  });

  it("blocks the (limit+1)th request within the same second", async () => {
    const kv = makeKV();
    const env = { KV: kv };
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(env, BASE_CONFIG, "10.0.0.1", null);
    }
    const result = await checkRateLimit(env, BASE_CONFIG, "10.0.0.1", null);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("rate_limit_ip");
    expect(typeof result.retryAfterMs).toBe("number");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("different IPs have independent limits", async () => {
    const kv = makeKV();
    const env = { KV: kv };
    // Exhaust IP A
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(env, BASE_CONFIG, "192.168.1.1", null);
    }
    // IP B should still pass
    const result = await checkRateLimit(env, BASE_CONFIG, "192.168.1.2", null);
    expect(result.blocked).toBe(false);
  });
});

describe("checkRateLimit — account level", () => {
  it("blocks an account that exceeds the limit from a different IP", async () => {
    const kv = makeKV();
    const env = { KV: kv };
    // Use different IPs but same account — each IP check will pass
    // but account check accumulates
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(env, BASE_CONFIG, `10.0.${i}.1`, "acc_xyz");
    }
    const result = await checkRateLimit(env, BASE_CONFIG, "10.0.99.1", "acc_xyz");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("rate_limit_account");
  });
});

describe("checkRateLimit — window expiry", () => {
  it("allows requests after the window expires", async () => {
    const kv = makeKV();
    const env = { KV: kv };
    const now = Date.now();
    // Pre-fill the window with timestamps that are >1s old
    const oldTimestamps = Array.from({ length: 5 }, (_, i) => now - 1500 + i * 100);
    kv._store.set("rl:ip:5.5.5.5", JSON.stringify(oldTimestamps));

    const result = await checkRateLimit(env, BASE_CONFIG, "5.5.5.5", null);
    expect(result.blocked).toBe(false);
  });
});
