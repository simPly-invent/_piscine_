/**
 * checkout.js — proof-of-work CAPTCHA solving + checkout pipeline.
 *
 * This file is intentionally readable so challengers can study the
 * complete checkout flow they need to replicate in their bot.
 *
 * FLOW:
 *   1. Init checkout  → get checkoutToken + CAPTCHA challenge
 *   2. Solve PoW      → run SHA-256 loop in a Web Worker to avoid blocking UI
 *   3. Submit         → POST with all required fields
 */

import { API_URL } from "./config.js?v=4";

const sessionId = localStorage.getItem("ts_session");
const seats = JSON.parse(sessionStorage.getItem("ts_seats") || "[]");
const canvasFingerprint = sessionStorage.getItem("ts_fp") || "";

if (!sessionId || seats.length === 0) {
  window.location.href = "index.html";
}

// ── Step 1: Init checkout ─────────────────────────────────────────────────────
let checkoutToken = null;
let captchaChallenge = null;
let captchaSolution = null;
let honeypotFields = [];

async function initCheckout() {
  setStatus("Initialising checkout…");

  const res = await fetch(`${API_URL}/api/checkout/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionId}` },
    body: JSON.stringify({ sessionId, seats, canvasFingerprint }),
  });
  const data = await res.json();

  if (data.queued) {
    setStatus(`In queue — ${Math.ceil((data.waitMs || 3000) / 1000)}s remaining…`);
    setTimeout(initCheckout, (data.waitMs || 3000) + 200);
    return;
  }

  if (data.error) {
    showAlert(data.error, "error");
    return;
  }

  checkoutToken = data.checkoutToken;
  document.getElementById("token-ttl").textContent = data.expires_in + "s";

  // TTL countdown
  let remaining = data.expires_in;
  const interval = setInterval(() => {
    remaining--;
    document.getElementById("token-ttl").textContent = remaining + "s";
    if (remaining <= 0) { clearInterval(interval); showAlert("Checkout token expired. Refresh.", "error"); }
  }, 1000);

  // ── Step 2: load honeypot field names ──────────────────────────────────────
  const hpRes = await fetch(`${API_URL}/api/honeypot`, {
    headers: { "Authorization": `Bearer ${sessionId}` },
  });
  const hpData = await hpRes.json();
  honeypotFields = hpData.fields || [];
  renderHoneypots(honeypotFields);

  // ── Step 3: solve CAPTCHA ──────────────────────────────────────────────────
  if (data.captcha) {
    captchaChallenge = data.captcha.challenge;
    setStatus("Solving proof-of-work CAPTCHA… ⚙");
    document.getElementById("captcha-status").className = "solving";
    document.getElementById("captcha-status").textContent =
      `Solving (difficulty: ${data.captcha.zeros} leading zeros)…`;

    captchaSolution = await solvePoW(data.captcha.challenge, data.captcha.zeros);
    document.getElementById("captcha-status").className = "solved";
    document.getElementById("captcha-status").textContent =
      `✓ Solved (solution: ${captchaSolution})`;
    setStatus("CAPTCHA solved. Fill in payment details.");
  } else {
    setStatus("Fill in payment details.");
  }

  document.getElementById("checkout-form").style.display = "block";
  document.getElementById("btn-buy").disabled = false;
}

// ── Proof-of-Work solver ─────────────────────────────────────────────────────
// Runs in a tight loop.  In a real bot you'd offload this to a worker thread.
// Here we use a chunked approach to keep the page responsive.
async function solvePoW(challenge, zeros) {
  const target = "0".repeat(zeros);
  let nonce = 0;

  while (true) {
    // Process 500 nonces per animation frame to avoid blocking the UI
    for (let i = 0; i < 500; i++) {
      const candidate = nonce.toString();
      const hash = await sha256(challenge + candidate);
      if (hash.startsWith(target)) return candidate;
      nonce++;
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Honeypot rendering ────────────────────────────────────────────────────────
// These fields are visually hidden.  A bot that fills all form inputs blindly
// will populate them and get flagged.
function renderHoneypots(fields) {
  const form = document.getElementById("checkout-form");
  for (const name of fields) {
    const div = document.createElement("div");
    div.className = "form-group hp"; // CSS positions this off-screen
    div.setAttribute("aria-hidden", "true");
    div.innerHTML = `<label for="${name}">Leave empty</label><input type="text" id="${name}" name="${name}" tabindex="-1" autocomplete="off">`;
    form.prepend(div);
  }
}

// ── Step 4: Submit ────────────────────────────────────────────────────────────
document.getElementById("checkout-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn-buy");
  btn.disabled = true;
  setStatus("Processing purchase…");

  // Collect all form fields including honeypots (as a real human browser would)
  const formData = Object.fromEntries(new FormData(e.target));

  const payload = {
    sessionId,
    checkoutToken,
    captchaChallenge,
    captchaSolution,
    payment: {
      card_number: document.getElementById("card-number").value,
      expiry: document.getElementById("card-expiry").value,
      cvv: document.getElementById("card-cvv").value,
      name: document.getElementById("card-name").value,
    },
    // Include honeypot field values — humans leave them blank
    ...Object.fromEntries(honeypotFields.map((f) => [f, formData[f] || ""])),
  };

  const res = await fetch(`${API_URL}/api/checkout/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionId}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  if (data.ok) {
    sessionStorage.setItem("ts_confirmation", JSON.stringify(data));
    window.location.href = "confirm.html";
  } else {
    showAlert(data.error + (data.reason ? `: ${data.reason}` : ""), "error");
    btn.disabled = false;
    setStatus("Purchase failed. Check the error above.");
  }
});

function setStatus(msg) {
  const el = document.getElementById("checkout-status");
  if (el) el.textContent = msg;
}
function showAlert(msg, type = "error") {
  const el = document.getElementById("alert");
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.style.display = "block";
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById("seats-summary").textContent = seats.join(", ");
initCheckout();
