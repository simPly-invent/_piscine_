/**
 * scoreboard.js — Server-Sent Events stream for the live scoreboard.
 * Pushes a full status snapshot every 2s for up to 10 minutes.
 */

import { getConfig } from "../config.js";
import { getBotState } from "../bots/defender.js";
import { getSession } from "../security/session-binding.js";
import { getSessionId } from "./shared.js";

export async function handleScoreboard(request, env) {
  const sessionId = getSessionId(request) || new URL(request.url).searchParams.get("session");
  const config    = await getConfig(env);

  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (data) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  (async () => {
    try {
      for (let i = 0; i < 300; i++) {
        let count = 0, total = 0;
        try {
          const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
          const res = await counterStub.fetch("http://do/counter", {
            method: "POST",
            body: JSON.stringify({ action: "status" }),
          });
          ({ count, total } = await res.json());
        } catch (_) {}

        const nowMs    = Date.now();
        const botState = await getBotState(env, total, config, nowMs);
        const sim      = (await env.KV.get("simulation", "json")) || {};
        const session  = sessionId ? await getSession(env, sessionId) : null;
        const elapsed  = sim.startedAt ? nowMs - sim.startedAt : 0;

        await send({
          ts:                 nowMs,
          tickets_remaining:  Math.max(0, count - botState.totalBotTickets),
          tickets_total:      total,
          bot_purchases:      botState.totalBotTickets,
          human_purchases:    Math.max(0, total - count - botState.totalBotTickets),
          elapsed_ms:         elapsed,
          difficulty:         config.difficulty,
          your_anomaly_score: session?.anomalyScore ?? null,
          your_banned:        session?.banned       ?? null,
          bot_feed: Object.entries(botState.botAccounts)
            .filter(([, v]) => v.bought > 0)
            .slice(0, 10)
            .map(([id, v]) => ({ id: id.slice(0, 10) + "…", type: v.type, bought: v.bought })),
        });

        await sleep(2000);
      }
    } catch (_) {
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type":                "text/event-stream",
      "Cache-Control":               "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
