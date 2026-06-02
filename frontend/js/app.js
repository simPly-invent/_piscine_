/**
 * app.js — event page: seat map, queue handling, session management.
 */
import { API_URL } from "./config.js?v=4";

// ── Session ───────────────────────────────────────────────────────────────────
let sessionId = localStorage.getItem("ts_session");
let accountId = localStorage.getItem("ts_account");

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (sessionId) h["Authorization"] = `Bearer ${sessionId}`;
  return h;
}

// ── Canvas Fingerprint ────────────────────────────────────────────────────────
async function getCanvasFingerprint() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220; canvas.height = 40;
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.font = "11pt Arial";
    ctx.fillText("TicketStorm 🎫", 2, 15);
    ctx.fillStyle = "rgba(102,204,0,0.7)";
    ctx.font = "18pt Times New Roman";
    ctx.fillText("ConcurrencyFTW", 4, 35);
    const data = canvas.toDataURL();
    let hash = 0;
    for (let i = 0; i < data.length; i++) hash = (hash * 31 + data.charCodeAt(i)) >>> 0;
    return hash.toString(16);
  } catch { return null; }
}

// ── Seat map ──────────────────────────────────────────────────────────────────
let selectedSeats = [];
const maxSelectable = 2;

async function loadEvent() {
  try {
    const res = await fetch(`${API_URL}/api/event`, { headers: authHeaders() });
    if (!res.ok) {
      showStatus(`Server error ${res.status} — simulation may need reset`, "error");
      return;
    }
    const data = await res.json();

    if (data.queued) {
      showQueue(data.waitMs, data.admitAt);
      return;
    }

    if (data.not_initialized) {
      showStatus("Simulation not started — call /api/reset first", "warn");
      return;
    }

    const remaining = data.tickets_remaining ?? 0;
    const total     = data.tickets_total ?? 0;

    // Update counter
    const el = document.getElementById("tickets-left");
    el.textContent = remaining;
    el.className = "ticket-count" +
      (remaining === 0 ? " sold-out" : remaining < 20 ? " critical" : remaining < 50 ? " low" : "");

    // Progress bar
    const pct = total > 0 ? Math.round((1 - remaining / total) * 100) : 0;
    const bar = document.getElementById("tickets-bar");
    if (bar) {
      bar.style.width = pct + "%";
      bar.style.background = pct > 80 ? "#e74c3c" : pct > 50 ? "#f39c12" : "#2ecc71";
    }
    const pctEl = document.getElementById("tickets-pct");
    if (pctEl) pctEl.textContent = pct + "% sold";

    if (remaining === 0) {
      showStatus("SOLD OUT — reset the simulation to play again", "error");
    }

    document.getElementById("event-name").textContent  = data.event?.name  ?? "—";
    document.getElementById("event-venue").textContent = data.event?.venue ?? "—";

    renderSeatMap(data.seats ?? []);
    hideStatus();

  } catch (err) {
    showStatus("Cannot reach server — check Worker URL in config.js", "error");
  }
}

function renderSeatMap(seats) {
  const map = document.getElementById("seat-map");
  if (!map) return;
  map.innerHTML = "";
  for (const seat of seats) {
    const el = document.createElement("div");
    el.className = `seat ${seat.status}`;
    el.dataset.id = seat.id;
    el.title = seat.id;
    el.textContent = seat.id;
    if (seat.status === "available") {
      el.addEventListener("click", () => toggleSeat(seat.id, el));
    }
    map.appendChild(el);
  }
}

function toggleSeat(id, el) {
  const idx = selectedSeats.indexOf(id);
  if (idx >= 0) {
    selectedSeats.splice(idx, 1);
    el.className = "seat available";
  } else {
    if (selectedSeats.length >= maxSelectable) {
      showAlert(`Max ${maxSelectable} seats per account.`, "warn");
      return;
    }
    selectedSeats.push(id);
    el.className = "seat selected";
  }
  document.getElementById("btn-checkout").disabled = selectedSeats.length === 0;
  document.getElementById("selected-count").textContent = selectedSeats.length;
}

// ── Queue overlay ─────────────────────────────────────────────────────────────
function showQueue(waitMs, admitAt) {
  const overlay = document.getElementById("queue-overlay");
  overlay.classList.add("active");
  const tick = () => {
    const remaining = Math.max(0, admitAt - Date.now());
    document.getElementById("queue-countdown").textContent = Math.ceil(remaining / 1000) + "s";
    if (remaining <= 0) { overlay.classList.remove("active"); loadEvent(); }
    else setTimeout(tick, 500);
  };
  tick();
}

// ── Status bar ────────────────────────────────────────────────────────────────
function showStatus(msg, type = "info") {
  const el = document.getElementById("status-bar");
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.style.display = "block";
}
function hideStatus() {
  const el = document.getElementById("status-bar");
  if (el) el.style.display = "none";
}

// ── Auth ──────────────────────────────────────────────────────────────────────
document.getElementById("btn-login")?.addEventListener("click", async () => {
  const email    = document.getElementById("inp-email").value.trim();
  const password = document.getElementById("inp-password").value;
  if (!email || !password) { showAlert("Fill in email and password.", "error"); return; }

  const res  = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!data.sessionId) { showAlert(data.error || "Login failed", "error"); return; }
  sessionId = data.sessionId;
  accountId = data.accountId;
  localStorage.setItem("ts_session", sessionId);
  localStorage.setItem("ts_account", accountId);
  showAlert("Logged in!", "success");
  updateAuthUI(true);
  loadEvent();
});

document.getElementById("btn-register")?.addEventListener("click", async () => {
  const username = document.getElementById("inp-username")?.value.trim();
  const email    = document.getElementById("inp-email").value.trim();
  const password = document.getElementById("inp-password").value;
  if (!email || !password) { showAlert("Fill in all fields.", "error"); return; }

  const res  = await fetch(`${API_URL}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: username || email.split("@")[0], email, password }),
  });
  const data = await res.json();
  if (!data.sessionId) { showAlert(data.error || "Registration failed", "error"); return; }
  sessionId = data.sessionId;
  accountId = data.accountId;
  localStorage.setItem("ts_session", sessionId);
  localStorage.setItem("ts_account", accountId);
  showAlert("Account created!", "success");
  updateAuthUI(true);
  loadEvent();
});

document.getElementById("btn-logout")?.addEventListener("click", () => {
  sessionId = null; accountId = null;
  localStorage.removeItem("ts_session");
  localStorage.removeItem("ts_account");
  updateAuthUI(false);
  showAlert("Logged out.", "success");
  loadEvent();
});

function updateAuthUI(loggedIn) {
  const form    = document.getElementById("auth-form");
  const logged  = document.getElementById("logged-in-info");
  if (form)   form.style.display   = loggedIn ? "none"  : "block";
  if (logged) logged.style.display = loggedIn ? "block" : "none";
  const accEl = document.getElementById("current-account");
  if (accEl) accEl.textContent = accountId ? accountId.slice(0, 12) + "…" : "";
}

// ── Checkout ──────────────────────────────────────────────────────────────────
document.getElementById("btn-checkout")?.addEventListener("click", async () => {
  if (!sessionId) { showAlert("Log in first.", "error"); return; }
  if (selectedSeats.length === 0) { showAlert("Select at least one seat.", "error"); return; }
  const fp = await getCanvasFingerprint();
  sessionStorage.setItem("ts_seats", JSON.stringify(selectedSeats));
  sessionStorage.setItem("ts_fp", fp || "");
  window.location.href = "checkout.html";
});

// ── Alerts ────────────────────────────────────────────────────────────────────
function showAlert(msg, type = "error") {
  const el = document.getElementById("alert");
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 4000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
if (sessionId) updateAuthUI(true);
loadEvent();
setInterval(loadEvent, 30000);
