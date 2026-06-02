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
// Uses a SYNCHRONOUS SHA-256 (sha256sync below) so we can hash millions of
// nonces per second. We process a big batch synchronously, then yield with
// setTimeout(0) so the UI stays responsive and the TTL countdown keeps ticking.
//
// Why not `await crypto.subtle.digest` per nonce? Each await yields to the
// event loop — at ~1M nonces for 5 leading zeros that takes >30s and the
// checkout token expires first. The sync hash does the same work in ~1-2s.
//
// In a real bot you'd run this in a worker thread (or WASM/Rust) — even faster.
async function solvePoW(challenge, zeros) {
  const target = "0".repeat(zeros);
  const BATCH = 20000; // hashes per synchronous chunk (~20-40ms)
  let nonce = 0;

  return new Promise((resolve) => {
    const step = () => {
      const end = nonce + BATCH;
      for (; nonce < end; nonce++) {
        if (sha256sync(challenge + nonce).startsWith(target)) {
          resolve(String(nonce));
          return;
        }
      }
      // Update the on-screen attempt counter, then yield
      const el = document.getElementById("captcha-status");
      if (el) el.textContent = `Solving (${zeros} zeros)… ${nonce.toLocaleString()} tries`;
      setTimeout(step, 0);
    };
    step();
  });
}

// Compact synchronous SHA-256 (returns lowercase hex). Pure JS, no async.
const _K = (() => {
  const k = [];
  let i = 0, n = 2;
  const isPrime = (x) => { for (let d = 2; d * d <= x; d++) if (x % d === 0) return false; return true; };
  while (k.length < 64) { if (isPrime(n)) k.push(Math.floor((n ** (1/3) % 1) * 2 ** 32) >>> 0); n++; }
  return k;
})();

function sha256sync(ascii) {
  const rightRotate = (v, a) => (v >>> a) | (v << (32 - a));
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
      h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;

  const bytes = [];
  for (let i = 0; i < ascii.length; i++) bytes.push(ascii.charCodeAt(i) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / 2 ** (8 * i)) & 0xff);

  const w = new Uint32Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++)
      w[i] = (bytes[off+i*4]<<24)|(bytes[off+i*4+1]<<16)|(bytes[off+i*4+2]<<8)|(bytes[off+i*4+3]);
    for (let i = 16; i < 64; i++) {
      const s0 = rightRotate(w[i-15],7)^rightRotate(w[i-15],18)^(w[i-15]>>>3);
      const s1 = rightRotate(w[i-2],17)^rightRotate(w[i-2],19)^(w[i-2]>>>10);
      w[i] = (w[i-16]+s0+w[i-7]+s1)|0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i++) {
      const S1=rightRotate(e,6)^rightRotate(e,11)^rightRotate(e,25);
      const ch=(e&f)^(~e&g);
      const t1=(h+S1+ch+_K[i]+w[i])|0;
      const S0=rightRotate(a,2)^rightRotate(a,13)^rightRotate(a,22);
      const maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)|0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;
    h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+h)|0;
  }
  const toHex = (v) => (v>>>0).toString(16).padStart(8,"0");
  return toHex(h0)+toHex(h1)+toHex(h2)+toHex(h3)+toHex(h4)+toHex(h5)+toHex(h6)+toHex(h7);
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
