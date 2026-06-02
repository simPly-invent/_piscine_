/**
 * scoreboard.js — Server-Sent Events stream for the live scoreboard.
 *
 * SSE vs WebSocket: SSE is HTTP/1.1 compatible, unidirectional (server→client),
 * and requires no handshake upgrade.  For a read-only live feed it's simpler
 * and works natively in all browsers without a library.
 *
 * The stream pushes a status snapshot every 2 seconds.  Cloudflare Workers
 * support streaming responses via TransformStream + ReadableStream.
 */

import { getConfig } from "../config.js";
import { getBotState } from "../bots/defender.js";
import { getSession } from "../security/session-binding.js";
import { getSessionId } from "./shared.js";

export async function handleScoreboard(request, env) {
  const sessionId = getSessionId(request) || new URL(request.url).searchParams.get("session");
  const config = await getConfig(env);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (data) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Kick off the streaming loop — Workers have a max CPU time, so we push a
  // bounded number of updates rather than running forever.
  (async () => {
    try {
      for (let i = 0; i < 300; i++) { // 300 × 2s = 10 minutes max
        const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
        const res = await counterStub.fetch("http://do/counter", {
          method: "POST",
          body: JSON.stringify({ action: "status" }),
        });
        const { count, total } = await res.json();
        const botState = await getBotState(env, total, config, Date.now());
        const session = sessionId ? await getSession(env, sessionId) : null;

        await send({
          ts: Date.now(),
          tickets_remaining: count,
          tickets_total: total,
          bot_purchases: botState.totalBotTickets,
          human_purchases: Math.max(0, total - count - botState.totalBotTickets),
          your_anomaly_score: session?.anomalyScore ?? null,
          your_banned: session?.banned ?? null,
          bot_feed: Object.entries(botState.botAccounts)
            .slice(0, 10)
            .map(([id, v]) => ({ id: id.slice(0, 8) + "…", type: v.type, bought: v.bought })),
        });

        await sleep(2000);
      }
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
