/**
 * ticket-counter.js — Durable Object that owns the canonical ticket count.
 *
 * WHY a Durable Object?
 * Cloudflare KV is eventually-consistent: two concurrent Workers can both read
 * count=5, both write count=4, and you silently lose a ticket.  Durable Objects
 * run in a single-threaded JavaScript event loop on a single machine, so all
 * requests are serialized.  This is the same guarantee you'd get from a mutex
 * in your C multithreading project — but at the distributed edge.
 *
 * Every ticket operation goes through fetch() which is the DO's entry point.
 * The caller sends a JSON body with an `action` field.
 */

export class TicketCounter {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const { action, amount = 1, accountId } = await request.json();

    switch (action) {
      case "init": {
        const total = amount;
        await this.state.storage.put("count", total);
        await this.state.storage.put("total", total);
        await this.state.storage.put("purchases", {});
        return json({ ok: true, count: total });
      }

      case "decrement": {
        const count = (await this.state.storage.get("count")) ?? 0;
        if (count <= 0) return json({ ok: false, reason: "sold_out", remaining: 0 });

        // Enforce per-account limit
        const purchases = (await this.state.storage.get("purchases")) ?? {};
        const owned = purchases[accountId] ?? 0;
        const config = (await this.state.storage.get("max_per_account")) ?? 2;
        if (owned >= config) {
          return json({ ok: false, reason: "account_limit", remaining: count });
        }

        const newCount = count - amount;
        purchases[accountId] = owned + amount;
        await this.state.storage.put("count", newCount);
        await this.state.storage.put("purchases", purchases);
        return json({ ok: true, remaining: newCount, owned: owned + amount });
      }

      case "status": {
        const count = (await this.state.storage.get("count")) ?? 0;
        const total = (await this.state.storage.get("total")) ?? 0;
        const purchases = (await this.state.storage.get("purchases")) ?? {};
        return json({ count, total, purchases });
      }

      case "set_config": {
        await this.state.storage.put("max_per_account", amount);
        return json({ ok: true });
      }

      case "reset": {
        await this.state.storage.deleteAll();
        return json({ ok: true });
      }

      default:
        return json({ ok: false, reason: "unknown_action" }, 400);
    }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
