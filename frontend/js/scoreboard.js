/**
 * scoreboard.js — SSE-powered live scoreboard.
 * Connects to /events/scoreboard and updates the UI on every push.
 */
import { API_URL } from "./config.js";

const sessionId = localStorage.getItem("ts_session");

function connect() {
  const url = sessionId
    ? `${API_URL}/events/scoreboard?session=${sessionId}`
    : `${API_URL}/events/scoreboard`;

  const es = new EventSource(url);

  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    update(data);
  };

  es.onerror = () => {
    document.getElementById("conn-status").textContent = "⚠ Reconnecting…";
    es.close();
    setTimeout(connect, 3000);
  };

  document.getElementById("conn-status").textContent = "● Live";
}

function update(data) {
  set("val-remaining", data.tickets_remaining);
  set("val-total", data.tickets_total);
  set("val-bot-purchases", data.bot_purchases);
  set("val-human-purchases", data.human_purchases);

  // Your anomaly score
  if (data.your_anomaly_score !== null) {
    const score = data.your_anomaly_score;
    set("val-anomaly", score);
    const fill = document.getElementById("anomaly-fill");
    if (fill) {
      fill.style.width = score + "%";
      fill.style.background =
        score < 40 ? "#2ecc71" : score < 65 ? "#f39c12" : "#e74c3c";
    }
    const bannedEl = document.getElementById("banned-status");
    if (bannedEl) {
      bannedEl.textContent = data.your_banned ? "⛔ BANNED" : "✓ Active";
      bannedEl.style.color = data.your_banned ? "#e74c3c" : "#2ecc71";
    }
  }

  // Bot activity feed
  const feed = document.getElementById("bot-feed");
  if (feed && data.bot_feed?.length) {
    const ts = new Date(data.ts).toLocaleTimeString();
    for (const bot of data.bot_feed.slice(0, 5)) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="ts">${ts}</span>${bot.type.toUpperCase()} bot <strong>${bot.id}</strong> → ${bot.bought} ticket(s)`;
      feed.prepend(li);
      if (feed.children.length > 40) feed.lastChild.remove();
    }
  }

  // Tickets remaining colour
  const remaining = data.tickets_remaining;
  const el = document.getElementById("val-remaining");
  if (el) {
    el.className = "val" + (remaining < 10 ? " critical" : remaining < 30 ? " low" : "");
  }
}

function set(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

connect();

// Poll /api/status as fallback if SSE isn't supported
if (typeof EventSource === "undefined") {
  setInterval(async () => {
    const res = await fetch(`${API_URL}/api/status`);
    const data = await res.json();
    update({
      tickets_remaining: data.tickets.remaining,
      tickets_total: data.tickets.total,
      bot_purchases: data.tickets.bot_purchases,
      human_purchases: data.tickets.human_purchases,
      your_anomaly_score: null,
      your_banned: null,
      bot_feed: data.bot_activity,
      ts: Date.now(),
    });
  }, 2000);
}
