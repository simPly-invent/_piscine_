/**
 * app.js — event page: seat map, queue handling, session management.
 */
import { API_URL } from "./config.js";

// ── Session ──────────────────────────────────────────────────────────────────
let sessionId = localStorage.getItem("ts_session");
let accountId = localStorage.getItem("ts_account");

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (sessionId) h["Authorization"] = `Bearer ${sessionId}`;
  return h;
}
// commentary test
// ── Canvas Fingerprint ────────────────────────────────────────────────────────
// Renders a specific string to an off-screen canvas and hashes the pixel data.
// The pixel output varies by OS/GPU/browser due to sub-pixel font rendering.
async function getCanvasFingerprint() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220; canvas.height = 40;
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.font = "11pt 'Arial'";
    ctx.fillText("TicketStorm 🎫✨", 2, 15);
    ctx.fillStyle = "rgba(102,204,0,0.7)";
    ctx.font = "18pt 'Times New Roman'";
    ctx.fillText("ConcurrencyFTW", 4, 35);
    const data = canvas.toDataURL();
    // Simple hash: sum char codes (not crypto-strength, just a fingerprint)
    let hash = 0;
    for (let i = 0; i < data.length; i++) hash = (hash * 31 + data.charCodeAt(i)) >>> 0;
    return hash.toString(16);
  } catch { return null; }
}

// ── Seat map ─────────────────────────────────────────────────────────────────
let selectedSeats = [];
let maxSelectable = 2;

async function loadEvent() {
  const res = await fetch(`${API_URL}/api/event`, { headers: authHeaders() });
  const data = await res.json();

  if (data.queued) {
    showQueue(data.waitMs, data.admitAt);
    return;
  }

  const remaining = data.tickets_remaining ?? 0;
  document.getElementById("tickets-left").textContent = remaining;
  document.getElementById("tickets-left").className =
    "ticket-count" +
    (remaining < 20 ? " critical" : remaining < 50 ? " low" : "");
  document.getElementById("event-name").textContent = data.event.name;
  document.getElementById("event-venue").textContent = data.event.venue;

  renderSeatMap(data.seats);
}

function renderSeatMap(seats) {
  const map = document.getElementById("seat-map");
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
      showAlert("You can only select up to " + maxSelectable + " seats.", "warn");
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
    document.getElementById("queue-countdown").textContent =
      Math.ceil(remaining / 1000) + "s";
    if (remaining <= 0) {
      overlay.classList.remove("active");
      loadEvent();
    } else {
      setTimeout(tick, 500);
    }
  };
  tick();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
document.getElementById("btn-login")?.addEventListener("click", async () => {
  const email = document.getElementById("inp-email").value.trim();
  const password = document.getElementById("inp-password").value;
  if (!email || !password) { showAlert("Fill in email and password.", "error"); return; }

  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!data.sessionId) { showAlert(data.error || "Login failed", "error"); return; }
  sessionId = data.sessionId;
  accountId = data.accountId;
  localStorage.setItem("ts_session", sessionId);
  localStorage.setItem("ts_account", accountId);
  showAlert("Logged in!", "success");
  loadEvent();
});

document.getElementById("btn-register")?.addEventListener("click", async () => {
  const username = document.getElementById("inp-username")?.value.trim();
  const email = document.getElementById("inp-email").value.trim();
  const password = document.getElementById("inp-password").value;
  if (!email || !password) { showAlert("Fill in all fields.", "error"); return; }

  const res = await fetch(`${API_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: username || email.split("@")[0], email, password }),
  });
  const data = await res.json();
  if (!data.sessionId) { showAlert(data.error || "Registration failed", "error"); return; }
  sessionId = data.sessionId;
  accountId = data.accountId;
  localStorage.setItem("ts_session", sessionId);
  localStorage.setItem("ts_account", accountId);
  showAlert("Account created! Go grab your tickets.", "success");
  loadEvent();
});

// ── Checkout button ───────────────────────────────────────────────────────────
document.getElementById("btn-checkout")?.addEventListener("click", async () => {
  if (!sessionId) { showAlert("Log in first.", "error"); return; }
  if (selectedSeats.length === 0) { showAlert("Select at least one seat.", "error"); return; }

  // Pass canvas fingerprint + selected seats to checkout page via sessionStorage
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
loadEvent();
setInterval(loadEvent, 5000); // refresh every 5s to keep seat map live
