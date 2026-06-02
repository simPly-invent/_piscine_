/**
 * scoreboard.js — SSE live scoreboard with session anomaly score.
 */
import { API_URL } from "./config.js?v=4";

const sessionId = localStorage.getItem("ts_session");

function connect() {
  const url = sessionId
    ? `${API_URL}/events/scoreboard?session=${sessionId}`
    : `${API_URL}/events/scoreboard`;

  const es = new EventSource(url);
  document.getElementById("conn-status").textContent = "● Live";
  document.getElementById("conn-status").style.color = "var(--green)";

  es.onmessage = (e) => {
    try { update(JSON.parse(e.data)); } catch (_) {}
  };

  es.onerror = () => {
    document.getElementById("conn-status").textContent = "⚠ Reconnecting…";
    document.getElementById("conn-status").style.color = "var(--yellow)";
    es.close();
    setTimeout(connect, 3000);
  };
}

function update(data) {
  const rem   = data.tickets_remaining ?? 0;
  const total = data.tickets_total ?? 0;

  set("val-remaining", rem);
  set("val-human",  data.human_purchases ?? 0);
  set("val-bot",    data.bot_purchases ?? 0);

  // Elapsed timer
  const ms = data.elapsed_ms ?? 0;
  set("val-elapsed", ms > 0
    ? `${Math.floor(ms/60000)}m ${Math.floor((ms%60000)/1000)}s`
    : "—");

  // Remaining bar
  const bar = document.getElementById("remaining-bar");
  if (bar && total > 0) {
    const pct = Math.round((rem / total) * 100);
    bar.style.width = pct + "%";
    bar.style.background = pct < 20 ? "#e74c3c" : pct < 50 ? "#f39c12" : "#2ecc71";
  }

  // Difficulty
  set("val-difficulty", data.difficulty || "—");

  // Ban threshold for this difficulty — drives the win-condition text + colours
  const threshold = data.ban_threshold ?? 50;
  const winText = document.getElementById("win-condition");
  if (winText) {
    winText.innerHTML =
      `Win: buy a ticket · keep anomaly <strong>&lt; ${threshold}</strong> · not banned`;
  }

  // Anomaly score
  if (data.your_anomaly_score !== null && data.your_anomaly_score !== undefined) {
    const score = data.your_anomaly_score;
    set("val-anomaly", score);
    set("val-threshold", threshold);
    const fill = document.getElementById("anomaly-fill");
    if (fill) {
      fill.style.width = Math.min(100, score) + "%";
      // Colour relative to THIS difficulty's ban threshold
      fill.style.background =
        score >= threshold ? "#e74c3c" :
        score >= threshold * 0.6 ? "#f39c12" : "#2ecc71";
    }
    const bannedEl = document.getElementById("banned-status");
    if (bannedEl) {
      bannedEl.textContent = data.your_banned ? "⛔ BANNED" : "✓ Active";
      bannedEl.style.color = data.your_banned ? "#e74c3c" : "#2ecc71";
    }
  }

  // Bot feed
  const feed = document.getElementById("bot-feed");
  if (feed && data.bot_feed?.length) {
    const ts = new Date().toLocaleTimeString();
    for (const bot of data.bot_feed.slice(0, 5)) {
      const li = document.createElement("li");
      li.style.cssText = "padding:.3rem 0;border-bottom:1px solid var(--border);color:var(--text-dim)";
      const typeColor = bot.type === "fast" ? "var(--red)" : bot.type === "slow" ? "var(--blue)" : "var(--yellow)";
      li.innerHTML =
        `<span style="color:#555;margin-right:.5rem">${ts}</span>` +
        `<span style="color:${typeColor}">${bot.type.toUpperCase()}</span>` +
        ` bot <strong>${bot.id}</strong> → ${bot.bought} ticket(s)`;
      feed.prepend(li);
      if (feed.children.length > 50) feed.lastChild.remove();
    }
  }

  // Colour the remaining count
  const remEl = document.getElementById("val-remaining");
  if (remEl) {
    remEl.style.color = rem === 0 ? "#e74c3c" : rem < 20 ? "#f39c12" : "#2ecc71";
    if (rem === 0) remEl.textContent = "SOLD OUT";
  }
}

function set(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// SSE
connect();

// Fallback polling if SSE not supported
if (typeof EventSource === "undefined") {
  setInterval(async () => {
    try {
      const r1 = await fetch(`${API_URL}/api/status`);
      const d1 = await r1.json();
      const r2 = sessionId ? await fetch(`${API_URL}/api/session`, {
        headers: { Authorization: `Bearer ${sessionId}` }
      }) : null;
      const d2 = r2 ? await r2.json() : {};
      update({
        tickets_remaining:  d1.tickets?.remaining,
        tickets_total:      d1.tickets?.total,
        human_purchases:    d1.tickets?.taken_by_humans,
        bot_purchases:      d1.tickets?.taken_by_bots,
        elapsed_ms:         d1.simulation?.elapsed_ms,
        difficulty:         d1.config?.difficulty,
        ban_threshold:      d1.config?.anomaly_ban_threshold,
        your_anomaly_score: d2.anomalyScore ?? null,
        your_banned:        d2.banned ?? null,
        bot_feed:           d1.bot_activity,
      });
    } catch (_) {}
  }, 3000);
}
