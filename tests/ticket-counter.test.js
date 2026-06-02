/**
 * ticket-counter.test.js
 *
 * Tests the TicketCounter Durable Object in isolation using a mock state.
 * Critical invariant: the ticket count must NEVER go negative, even under
 * concurrent requests — this is the same guarantee a mutex provides in C.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TicketCounter } from "../worker/src/durable-objects/ticket-counter.js";

// Minimal mock of the Durable Object state (synchronous in-memory storage)
function makeMockState(initial = {}) {
  const storage = new Map(Object.entries(initial));
  return {
    storage: {
      get: async (key) => storage.get(key),
      put: async (key, value) => storage.set(key, value),
      delete: async (key) => storage.delete(key),
      deleteAll: async () => storage.clear(),
    },
  };
}

function makeRequest(body) {
  return { json: async () => body };
}

describe("TicketCounter — init", () => {
  it("initialises the counter to the given total", async () => {
    const state = makeMockState();
    const counter = new TicketCounter(state, {});
    const res = await counter.fetch(makeRequest({ action: "init", amount: 100 }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBe(100);
  });
});

describe("TicketCounter — decrement", () => {
  let counter;

  beforeEach(async () => {
    const state = makeMockState();
    counter = new TicketCounter(state, {});
    await counter.fetch(makeRequest({ action: "init", amount: 5 }));
    await counter.fetch(makeRequest({ action: "set_config", amount: 2 }));
  });

  it("decrements the count on a successful purchase", async () => {
    const res = await counter.fetch(makeRequest({ action: "decrement", amount: 1, accountId: "acc1" }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.remaining).toBe(4);
  });

  it("returns sold_out when count reaches 0", async () => {
    for (let i = 0; i < 5; i++) {
      await counter.fetch(makeRequest({ action: "decrement", amount: 1, accountId: `acc${i}` }));
    }
    const res = await counter.fetch(makeRequest({ action: "decrement", amount: 1, accountId: "acc99" }));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("sold_out");
    expect(data.remaining).toBe(0);
  });

  it("ticket count never goes below zero under sequential exhaustion", async () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      const res = await counter.fetch(makeRequest({ action: "decrement", amount: 1, accountId: `acct${i}` }));
      const data = await res.json();
      results.push(data);
    }
    const status = await counter.fetch(makeRequest({ action: "status" }));
    const { count } = await status.json();
    expect(count).toBeGreaterThanOrEqual(0);

    const successful = results.filter((r) => r.ok);
    expect(successful.length).toBe(5); // only 5 available
  });

  it("enforces per-account ticket limit", async () => {
    await counter.fetch(makeRequest({ action: "decrement", amount: 1, accountId: "power_buyer" }));
    await counter.fetch(makeRequest({ action: "decrement", amount: 1, accountId: "power_buyer" }));
    const res = await counter.fetch(makeRequest({ action: "decrement", amount: 1, accountId: "power_buyer" }));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("account_limit");
  });
});

describe("TicketCounter — reset", () => {
  it("clears all state on reset", async () => {
    const state = makeMockState();
    const counter = new TicketCounter(state, {});
    await counter.fetch(makeRequest({ action: "init", amount: 50 }));
    await counter.fetch(makeRequest({ action: "reset" }));
    const res = await counter.fetch(makeRequest({ action: "status" }));
    const { count } = await res.json();
    expect(count).toBe(0);
  });
});
