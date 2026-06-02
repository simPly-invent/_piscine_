/**
 * token-expiry.test.js
 *
 * Tests checkout token lifecycle: issuance, single-use enforcement,
 * TTL expiry, and session binding.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { issueCheckoutToken, consumeCheckoutToken } from "../worker/src/security/token-rotation.js";

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
    _store: store,
  };
}

const CONFIG = { checkout_token_ttl_seconds: 30 };
const SESSION_ID = "test-session-abc";
const ACCOUNT_ID = "test-account-xyz";
const SEATS = ["A1", "A2"];

describe("issueCheckoutToken", () => {
  it("returns a token and expiry", async () => {
    const kv = makeKV();
    const { token, expires_in } = await issueCheckoutToken(
      { KV: kv }, CONFIG, SESSION_ID, ACCOUNT_ID, SEATS
    );
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(16);
    expect(expires_in).toBe(30);
  });

  it("stores the token in KV with correct metadata", async () => {
    const kv = makeKV();
    const { token } = await issueCheckoutToken(
      { KV: kv }, CONFIG, SESSION_ID, ACCOUNT_ID, SEATS
    );
    const stored = JSON.parse(kv._store.get(`ct:${token}`));
    expect(stored.sessionId).toBe(SESSION_ID);
    expect(stored.accountId).toBe(ACCOUNT_ID);
    expect(stored.seats).toEqual(SEATS);
    expect(stored.used).toBe(false);
  });
});

describe("consumeCheckoutToken", () => {
  it("succeeds on first use", async () => {
    const kv = makeKV();
    const { token } = await issueCheckoutToken(
      { KV: kv }, CONFIG, SESSION_ID, ACCOUNT_ID, SEATS
    );
    const result = await consumeCheckoutToken({ KV: kv }, token, SESSION_ID);
    expect(result.valid).toBe(true);
    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(result.seats).toEqual(SEATS);
  });

  it("rejects on second use (single-use enforcement)", async () => {
    const kv = makeKV();
    const { token } = await issueCheckoutToken(
      { KV: kv }, CONFIG, SESSION_ID, ACCOUNT_ID, SEATS
    );
    await consumeCheckoutToken({ KV: kv }, token, SESSION_ID);
    const result = await consumeCheckoutToken({ KV: kv }, token, SESSION_ID);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("token_already_used");
  });

  it("rejects an unknown token", async () => {
    const kv = makeKV();
    const result = await consumeCheckoutToken({ KV: kv }, "nonexistent_token", SESSION_ID);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("token_not_found");
  });

  it("rejects a token from a different session (session binding)", async () => {
    const kv = makeKV();
    const { token } = await issueCheckoutToken(
      { KV: kv }, CONFIG, SESSION_ID, ACCOUNT_ID, SEATS
    );
    const result = await consumeCheckoutToken({ KV: kv }, token, "different-session-999");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("token_session_mismatch");
    expect(result.anomalyScore).toBeGreaterThan(0);
  });

  it("rejects an expired token", async () => {
    const kv = makeKV();
    const { token } = await issueCheckoutToken(
      { KV: kv }, CONFIG, SESSION_ID, ACCOUNT_ID, SEATS
    );
    // Manually expire the token by backdating its expiry
    const stored = JSON.parse(kv._store.get(`ct:${token}`));
    stored.expiresAt = Date.now() - 1000;
    kv._store.set(`ct:${token}`, JSON.stringify(stored));

    const result = await consumeCheckoutToken({ KV: kv }, token, SESSION_ID);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("token_expired");
  });
});
