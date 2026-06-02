var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-TfKpVX/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// src/durable-objects/ticket-counter.js
var TicketCounter = class {
  static {
    __name(this, "TicketCounter");
  }
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
        const count = await this.state.storage.get("count") ?? 0;
        if (count <= 0) return json({ ok: false, reason: "sold_out", remaining: 0 });
        const purchases = await this.state.storage.get("purchases") ?? {};
        const owned = purchases[accountId] ?? 0;
        const config = await this.state.storage.get("max_per_account") ?? 2;
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
        const count = await this.state.storage.get("count") ?? 0;
        const total = await this.state.storage.get("total") ?? 0;
        const purchases = await this.state.storage.get("purchases") ?? {};
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
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(json, "json");

// src/config.js
var DEFAULTS = {
  tickets_total: 100,
  max_tickets_per_account: 2,
  max_accounts_per_ip: 3,
  defender_bots_count: 20,
  difficulty: "easy",
  session_ttl_seconds: 1800,
  checkout_token_ttl_seconds: 30,
  rate_limit_requests_per_second: 10,
  captcha_enabled: true,
  fingerprinting_enabled: true,
  reset_secret: "changeme"
};
var DIFFICULTY_OVERRIDES = {
  easy: {
    rate_limit_requests_per_second: 20,
    defender_bots_count: 5,
    captcha_enabled: false,
    fingerprinting_enabled: false,
    anomaly_ban_threshold: 80,
    behavioral_min_action_ms: 100,
    captcha_pow_zeros: 2
  },
  medium: {
    rate_limit_requests_per_second: 10,
    defender_bots_count: 20,
    captcha_enabled: true,
    fingerprinting_enabled: true,
    anomaly_ban_threshold: 70,
    behavioral_min_action_ms: 200,
    captcha_pow_zeros: 3
  },
  hard: {
    rate_limit_requests_per_second: 5,
    defender_bots_count: 50,
    captcha_enabled: true,
    fingerprinting_enabled: true,
    anomaly_ban_threshold: 60,
    behavioral_min_action_ms: 300,
    captcha_pow_zeros: 4
  },
  nightmare: {
    rate_limit_requests_per_second: 2,
    defender_bots_count: 200,
    captcha_enabled: true,
    fingerprinting_enabled: true,
    anomaly_ban_threshold: 30,
    behavioral_min_action_ms: 500,
    captcha_pow_zeros: 5
  }
};
async function getConfig(env) {
  const stored = await env.KV.get("config", "json");
  const base = { ...DEFAULTS, ...stored || {} };
  const overrides = DIFFICULTY_OVERRIDES[base.difficulty] || DIFFICULTY_OVERRIDES.medium;
  return { ...base, ...overrides };
}
__name(getConfig, "getConfig");
async function setConfig(env, partial) {
  const current = await env.KV.get("config", "json") || {};
  await env.KV.put("config", JSON.stringify({ ...current, ...partial }));
}
__name(setConfig, "setConfig");

// src/security/rate-limiter.js
var memoryWindows = /* @__PURE__ */ new Map();
async function checkRateLimit(env, config, ip, accountId) {
  const limit = config.rate_limit_requests_per_second;
  const now = Date.now();
  const ipResult = await slideWindow(env, `rl:ip:${ip}`, now, limit);
  if (ipResult.blocked) {
    return { blocked: true, reason: "rate_limit_ip", retryAfterMs: ipResult.retryAfterMs };
  }
  if (accountId) {
    const accResult = await slideWindow(env, `rl:acc:${accountId}`, now, limit);
    if (accResult.blocked) {
      return { blocked: true, reason: "rate_limit_account", retryAfterMs: accResult.retryAfterMs };
    }
  }
  return { blocked: false };
}
__name(checkRateLimit, "checkRateLimit");
async function slideWindow(env, key, now, limit) {
  const windowMs = 1e3;
  let timestamps = memoryWindows.get(key) || [];
  timestamps = timestamps.filter((t) => now - t < windowMs);
  if (timestamps.length >= limit) {
    const oldest = Math.min(...timestamps);
    return { blocked: true, retryAfterMs: windowMs - (now - oldest) };
  }
  timestamps.push(now);
  memoryWindows.set(key, timestamps);
  const syncKey = `${key}_sync`;
  const lastSync = memoryWindows.get(syncKey) || 0;
  if (now - lastSync > 5e3) {
    memoryWindows.set(syncKey, now);
    env.KV.put(key, JSON.stringify(timestamps), { expirationTtl: 60 }).catch(() => {
    });
  }
  return { blocked: false, remaining: limit - timestamps.length };
}
__name(slideWindow, "slideWindow");

// src/security/ip-reputation.js
var DATACENTER_CIDRS = [
  // AWS
  "3.0.0.0/8",
  "13.32.0.0/15",
  "18.0.0.0/8",
  "34.192.0.0/10",
  "52.0.0.0/8",
  "54.0.0.0/8",
  // GCP
  "34.0.0.0/9",
  "35.184.0.0/13",
  "104.154.0.0/15",
  // Azure
  "13.64.0.0/11",
  "20.0.0.0/8",
  "40.64.0.0/10",
  // DigitalOcean
  "104.16.0.0/12",
  "159.65.0.0/16",
  "167.99.0.0/16",
  // Linode / Akamai
  "45.33.0.0/17",
  "45.56.0.0/21",
  "45.79.0.0/17",
  // OVH
  "51.68.0.0/16",
  "51.75.0.0/16",
  "54.36.0.0/14"
  // Cloudflare (meta — would block the Worker itself in prod, included for study)
  // "104.16.0.0/13",
];
var parsedCidrs = DATACENTER_CIDRS.map(parseCidr).filter(Boolean);
function isDatacenterIP(ip) {
  const ipNum = ipToNumber(ip);
  if (ipNum === null) return false;
  return parsedCidrs.some(({ network, mask }) => (ipNum & mask) === network);
}
__name(isDatacenterIP, "isDatacenterIP");
function ipToNumber(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3];
}
__name(ipToNumber, "ipToNumber");
function parseCidr(cidr) {
  const [addr, prefix] = cidr.split("/");
  const prefixLen = parseInt(prefix, 10);
  const mask = prefixLen === 0 ? 0 : ~((1 << 32 - prefixLen) - 1) >>> 0;
  const network = (ipToNumber(addr) & mask) >>> 0;
  return { network, mask };
}
__name(parseCidr, "parseCidr");

// src/security/session-binding.js
async function createSession(env, config, sessionId, ip, userAgent, accountId = null) {
  const session = {
    sessionId,
    ip,
    userAgent,
    accountId,
    createdAt: Date.now(),
    anomalyScore: 0,
    banned: false
  };
  await env.KV.put(`sess:${sessionId}`, JSON.stringify(session), {
    expirationTtl: config.session_ttl_seconds
  });
  return session;
}
__name(createSession, "createSession");
async function getSession(env, sessionId) {
  return env.KV.get(`sess:${sessionId}`, "json");
}
__name(getSession, "getSession");
async function validateSessionBinding(env, sessionId, ip, userAgent) {
  const session = await env.KV.get(`sess:${sessionId}`, "json");
  if (!session) return { valid: false, reason: "session_not_found" };
  if (session.banned) return { valid: false, reason: "session_banned" };
  let anomalyDelta = 0;
  const reasons = [];
  if (session.ip !== ip) {
    anomalyDelta += 35;
    reasons.push(`ip_changed_${session.ip}_to_${ip}`);
  }
  if (session.userAgent !== userAgent) {
    anomalyDelta += 20;
    reasons.push("user_agent_changed");
  }
  return { valid: true, anomalyDelta, reasons, session };
}
__name(validateSessionBinding, "validateSessionBinding");
async function updateAnomalyScore(env, config, sessionId, delta) {
  const session = await env.KV.get(`sess:${sessionId}`, "json");
  if (!session) return null;
  const newScore = Math.min(100, session.anomalyScore + delta);
  const threshold = config.anomaly_ban_threshold ?? 70;
  const banned = newScore >= threshold;
  const updated = { ...session, anomalyScore: newScore, banned };
  await env.KV.put(`sess:${sessionId}`, JSON.stringify(updated), {
    expirationTtl: config.session_ttl_seconds
  });
  return { anomalyScore: newScore, banned };
}
__name(updateAnomalyScore, "updateAnomalyScore");

// src/security/anomaly-score.js
var SCORE_DELTAS = {
  rate_limit_violation: 20,
  honeypot_triggered: 40,
  behavioral_flag: 25,
  fingerprint_mismatch: 30,
  datacenter_ip: 50,
  session_binding_fail: 35,
  token_session_mismatch: 35
};
async function applyScoreDeltas(env, config, sessionId, deltas) {
  if (!deltas || deltas.length === 0) return null;
  const total = deltas.reduce((s, d) => s + d, 0);
  return updateAnomalyScore(env, config, sessionId, total);
}
__name(applyScoreDeltas, "applyScoreDeltas");

// src/utils/crypto.js
function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomToken, "randomToken");
async function sha256hex(text) {
  const encoded = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
async function verifyPoW(challenge, solution, zeros) {
  const hash = await sha256hex(challenge + solution);
  return hash.startsWith("0".repeat(zeros));
}
__name(verifyPoW, "verifyPoW");
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
__name(safeEqual, "safeEqual");

// src/utils/logger.js
var LOG_KEY = "request_logs";
var MAX_ENTRIES = 500;
async function logRequest(env, entry) {
  try {
    const logs = await env.KV.get(LOG_KEY, "json") || [];
    logs.push({ ts: Date.now(), ...entry });
    const trimmed = logs.slice(-MAX_ENTRIES);
    await env.KV.put(LOG_KEY, JSON.stringify(trimmed), { expirationTtl: 86400 });
  } catch (err) {
    console.error("logRequest failed (non-fatal):", err.message);
  }
}
__name(logRequest, "logRequest");
async function getLogs(env) {
  return await env.KV.get(LOG_KEY, "json") || [];
}
__name(getLogs, "getLogs");
async function clearLogs(env) {
  await env.KV.delete(LOG_KEY);
}
__name(clearLogs, "clearLogs");

// src/handlers/shared.js
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
__name(jsonResponse, "jsonResponse");
function getIP(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0].trim() || "0.0.0.0";
}
__name(getIP, "getIP");
function getUA(request) {
  return request.headers.get("User-Agent") || "";
}
__name(getUA, "getUA");
function getSessionId(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(request.url);
  return url.searchParams.get("session") || null;
}
__name(getSessionId, "getSessionId");

// src/handlers/auth.js
async function handleRegister(request, env, config) {
  const ip = getIP(request);
  const ua = getUA(request);
  const body = await request.json().catch(() => ({}));
  const { username, email, password } = body;
  if (!username || !email || !password) {
    return jsonResponse({ error: "missing_fields" }, 400);
  }
  if (isDatacenterIP(ip)) {
    await logRequest(env, { type: "register_blocked", reason: "datacenter_ip", ip });
    return jsonResponse({ error: "registration_blocked" }, 403);
  }
  const ipAccountsKey = `ip_accs:${ip}`;
  const ipAccounts = await env.KV.get(ipAccountsKey, "json") || [];
  if (ipAccounts.length >= config.max_accounts_per_ip) {
    return jsonResponse({ error: "too_many_accounts_from_ip" }, 429);
  }
  const emailLower = email.toLowerCase();
  const accKey = `acc:${emailLower}`;
  if (await env.KV.get(accKey)) {
    return jsonResponse({ error: "email_already_registered" }, 409);
  }
  const accountId = randomToken(16);
  const passwordHash = await sha256hex(password + accountId);
  await env.KV.put(
    accKey,
    JSON.stringify({ accountId, username, email: emailLower, passwordHash, createdAt: Date.now() }),
    { expirationTtl: config.session_ttl_seconds * 2 }
  );
  ipAccounts.push(accountId);
  await env.KV.put(ipAccountsKey, JSON.stringify(ipAccounts), { expirationTtl: config.session_ttl_seconds });
  const sessionId = randomToken(32);
  await createSession(env, config, sessionId, ip, ua, accountId);
  await logRequest(env, { type: "register", accountId, ip });
  return jsonResponse({ ok: true, accountId, sessionId }, 201);
}
__name(handleRegister, "handleRegister");
async function handleLogin(request, env, config) {
  const ip = getIP(request);
  const ua = getUA(request);
  const body = await request.json().catch(() => ({}));
  const { email, password } = body;
  if (!email || !password) return jsonResponse({ error: "missing_fields" }, 400);
  const account = await env.KV.get(`acc:${email.toLowerCase()}`, "json");
  if (!account) return jsonResponse({ error: "invalid_credentials" }, 401);
  const expectedHash = await sha256hex(password + account.accountId);
  if (account.passwordHash !== expectedHash) {
    return jsonResponse({ error: "invalid_credentials" }, 401);
  }
  const sessionId = randomToken(32);
  await createSession(env, config, sessionId, ip, ua, account.accountId);
  await logRequest(env, { type: "login", accountId: account.accountId, ip });
  return jsonResponse({ ok: true, accountId: account.accountId, sessionId });
}
__name(handleLogin, "handleLogin");

// src/security/token-rotation.js
async function issueCheckoutToken(env, config, sessionId, accountId, seats) {
  const token = randomToken(32);
  const ttl = config.checkout_token_ttl_seconds ?? 30;
  await env.KV.put(
    `ct:${token}`,
    JSON.stringify({
      sessionId,
      accountId,
      seats,
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttl * 1e3,
      used: false
    }),
    { expirationTtl: Math.max(60, ttl + 5) }
  );
  return { token, expires_in: ttl };
}
__name(issueCheckoutToken, "issueCheckoutToken");
async function consumeCheckoutToken(env, token, sessionId) {
  const stored = await env.KV.get(`ct:${token}`, "json");
  if (!stored) return { valid: false, reason: "token_not_found" };
  if (stored.used) return { valid: false, reason: "token_already_used" };
  if (Date.now() > stored.expiresAt) return { valid: false, reason: "token_expired" };
  if (stored.sessionId !== sessionId) {
    return { valid: false, reason: "token_session_mismatch", anomalyScore: 35 };
  }
  await env.KV.put(
    `ct:${token}`,
    JSON.stringify({ ...stored, used: true }),
    { expirationTtl: 60 }
  );
  return { valid: true, accountId: stored.accountId, seats: stored.seats };
}
__name(consumeCheckoutToken, "consumeCheckoutToken");

// src/bots/defender.js
var PROFILE_DELAYS = {
  fast: { min: 800, max: 2e3 },
  slow: { min: 2e3, max: 5e3 },
  clumsy: { min: 1200, max: 3500 }
};
var DIFFICULTY_PROFILES = {
  easy: { fast: 0.1, slow: 0.7, clumsy: 0.2 },
  medium: { fast: 0.3, slow: 0.5, clumsy: 0.2 },
  hard: { fast: 0.5, slow: 0.3, clumsy: 0.2 },
  nightmare: { fast: 0.7, slow: 0.2, clumsy: 0.1 }
};
var FIRST_NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy"];
var LAST_NAMES = ["Smith", "Jones", "Williams", "Brown", "Davis", "Miller", "Wilson", "Moore", "Taylor", "Anderson"];
var DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"];
function fakeName() {
  return `${FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]}`;
}
__name(fakeName, "fakeName");
function fakeEmail(name) {
  const slug = name.toLowerCase().replace(" ", ".") + Math.floor(Math.random() * 999);
  return `${slug}@${DOMAINS[Math.floor(Math.random() * DOMAINS.length)]}`;
}
__name(fakeEmail, "fakeEmail");
async function initBotSchedule(env, config, simStartMs) {
  const count = config.defender_bots_count;
  const profiles = DIFFICULTY_PROFILES[config.difficulty] || DIFFICULTY_PROFILES.medium;
  const maxTickets = config.max_tickets_per_account;
  const simDuration = config.session_ttl_seconds * 1e3;
  const bots = [];
  for (let i = 0; i < count; i++) {
    const roll = Math.random();
    let type;
    if (roll < profiles.fast) type = "fast";
    else if (roll < profiles.fast + profiles.slow) type = "slow";
    else type = "clumsy";
    const name = fakeName();
    const email = fakeEmail(name);
    const ua = randomUserAgent();
    const accountId = `bot_${randomToken(8)}`;
    const delays = PROFILE_DELAYS[type];
    const actions = [];
    let t = simStartMs + randInt(delays.min, delays.max);
    let purchased = 0;
    while (t < simStartMs + simDuration && purchased < maxTickets) {
      const failCaptcha = type === "clumsy" && Math.random() < 0.3;
      actions.push({ t, failCaptcha });
      t += randInt(delays.min, delays.max);
      if (!failCaptcha) purchased++;
    }
    bots.push({ accountId, name, email, ua, type, actions, ticketsBought: 0 });
  }
  await env.KV.put("bot_schedule", JSON.stringify({ bots, generatedAt: simStartMs }), {
    expirationTtl: config.session_ttl_seconds + 60
  });
  return bots.length;
}
__name(initBotSchedule, "initBotSchedule");
async function getBotState(env, ticketsAvailableAtStart, config, nowMs) {
  const data = await env.KV.get("bot_schedule", "json");
  if (!data) return { totalBotTickets: 0, botAccounts: {} };
  let ticketsLeft = ticketsAvailableAtStart;
  const botAccounts = {};
  for (const bot of data.bots) {
    let bought = 0;
    for (const action of bot.actions) {
      if (action.t > nowMs) break;
      if (action.failCaptcha) continue;
      if (ticketsLeft <= 0) break;
      if (bought >= config.max_tickets_per_account) break;
      bought++;
      ticketsLeft--;
    }
    if (bought > 0) botAccounts[bot.accountId] = { bought, type: bot.type };
  }
  const totalBotTickets = Object.values(botAccounts).reduce((s, v) => s + v.bought, 0);
  return { totalBotTickets, botAccounts };
}
__name(getBotState, "getBotState");
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
__name(randInt, "randInt");
var UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15"
];
function randomUserAgent() {
  return UAS[Math.floor(Math.random() * UAS.length)];
}
__name(randomUserAgent, "randomUserAgent");

// src/security/captcha.js
var CHALLENGE_TTL = 120;
async function issueCaptcha(env, config) {
  if (!config.captcha_enabled) return null;
  const challenge = randomToken(16);
  const zeros = config.captcha_pow_zeros ?? 3;
  const expiresAt = Date.now() + CHALLENGE_TTL * 1e3;
  await env.KV.put(
    `captcha:${challenge}`,
    JSON.stringify({ zeros, expiresAt, used: false }),
    { expirationTtl: CHALLENGE_TTL + 10 }
  );
  return { challenge, zeros, expires_at: expiresAt };
}
__name(issueCaptcha, "issueCaptcha");
async function validateCaptcha(env, config, challenge, solution) {
  if (!config.captcha_enabled) return { valid: true };
  if (!challenge || solution === void 0) {
    return { valid: false, reason: "captcha_missing" };
  }
  const stored = await env.KV.get(`captcha:${challenge}`, "json");
  if (!stored) return { valid: false, reason: "captcha_expired_or_unknown" };
  if (stored.used) return { valid: false, reason: "captcha_already_used" };
  if (Date.now() > stored.expiresAt) return { valid: false, reason: "captcha_expired" };
  const ok = await verifyPoW(challenge, String(solution), stored.zeros);
  if (!ok) return { valid: false, reason: "captcha_wrong_solution" };
  await env.KV.put(
    `captcha:${challenge}`,
    JSON.stringify({ ...stored, used: true }),
    { expirationTtl: 60 }
  );
  return { valid: true };
}
__name(validateCaptcha, "validateCaptcha");

// src/security/honeypot.js
var HONEYPOT_FIELD_NAMES = ["email_confirm", "phone_verify", "address_check"];
async function issueHoneypotConfig(env, sessionId) {
  const fields = HONEYPOT_FIELD_NAMES.map((base) => `${base}_${randomToken(4)}`);
  await env.KV.put(`hp:${sessionId}`, JSON.stringify(fields), { expirationTtl: 3600 });
  return fields;
}
__name(issueHoneypotConfig, "issueHoneypotConfig");
async function checkHoneypot(env, sessionId, body) {
  const fields = await env.KV.get(`hp:${sessionId}`, "json");
  if (!fields) return false;
  for (const field of fields) {
    if (body[field] !== void 0 && body[field] !== "") {
      return true;
    }
  }
  return false;
}
__name(checkHoneypot, "checkHoneypot");

// src/security/behavioral.js
async function recordAction(env, sessionId, action, clientTs) {
  const key = `beh:${sessionId}`;
  const history = await env.KV.get(key, "json") || [];
  history.push({ action, clientTs, serverTs: Date.now() });
  await env.KV.put(key, JSON.stringify(history.slice(-20)), { expirationTtl: 3600 });
}
__name(recordAction, "recordAction");
async function analyzeSession(env, sessionId, config) {
  const history = await env.KV.get(`beh:${sessionId}`, "json") || [];
  if (history.length < 2) return { suspicious: false, score: 0 };
  const intervals = [];
  for (let i = 1; i < history.length; i++) {
    intervals.push(history[i].serverTs - history[i - 1].serverTs);
  }
  const minInterval = Math.min(...intervals);
  const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const stddev = Math.sqrt(
    intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length
  );
  const cv = mean > 0 ? stddev / mean : 0;
  const minMs = config.behavioral_min_action_ms ?? 200;
  let score = 0;
  const reasons = [];
  if (minInterval < minMs) {
    score += 25;
    reasons.push(`step_too_fast_${minInterval}ms`);
  }
  if (intervals.length >= 4 && cv < 0.05) {
    score += 20;
    reasons.push(`robotic_timing_cv_${cv.toFixed(3)}`);
  }
  const totalMs = history[history.length - 1].serverTs - history[0].serverTs;
  if (history.length >= 4 && totalMs < 3e3) {
    score += 15;
    reasons.push(`session_too_fast_${totalMs}ms`);
  }
  return { suspicious: score > 0, score, reasons };
}
__name(analyzeSession, "analyzeSession");

// src/security/fingerprint.js
async function storeFingerprint(env, sessionId, canvasHash, request) {
  const fp = buildHeaderFingerprint(request);
  await env.KV.put(
    `fp:${sessionId}`,
    JSON.stringify({ canvasHash, headerProfile: fp }),
    { expirationTtl: 3600 }
  );
}
__name(storeFingerprint, "storeFingerprint");
async function checkFingerprint(env, config, sessionId, canvasHash, request) {
  if (!config.fingerprinting_enabled) return { score: 0 };
  const stored = await env.KV.get(`fp:${sessionId}`, "json");
  let score = 0;
  const reasons = [];
  const headerScore = scoreHeaders(request);
  if (headerScore > 3) {
    score += 15;
    reasons.push(`suspicious_headers_score_${headerScore}`);
  }
  if (stored) {
    if (canvasHash && stored.canvasHash && canvasHash !== stored.canvasHash) {
      score += 25;
      reasons.push("canvas_fingerprint_mismatch");
    }
  } else if (canvasHash) {
    await storeFingerprint(env, sessionId, canvasHash, request);
  }
  return { score, reasons };
}
__name(checkFingerprint, "checkFingerprint");
function scoreHeaders(request) {
  const headers = [...request.headers.keys()].map((h) => h.toLowerCase());
  let missing = 0;
  for (const expected of ["accept", "accept-language", "user-agent"]) {
    if (!headers.includes(expected)) missing++;
  }
  const hasSecFetch = headers.some((h) => h.startsWith("sec-fetch-"));
  return missing * 2 + (hasSecFetch ? 0 : 2);
}
__name(scoreHeaders, "scoreHeaders");
function buildHeaderFingerprint(request) {
  return [...request.headers.keys()].map((h) => h.toLowerCase()).sort().join(",");
}
__name(buildHeaderFingerprint, "buildHeaderFingerprint");

// src/security/queue.js
var QUEUE_DELAYS = {
  easy: [0, 0],
  medium: [2e3, 8e3],
  hard: [5e3, 2e4],
  nightmare: [1e4, 45e3]
};
async function enqueue(env, config, sessionId) {
  const [minMs, maxMs] = QUEUE_DELAYS[config.difficulty] || [0, 0];
  if (minMs === 0 && maxMs === 0) {
    return { queued: false, admitted: true };
  }
  const existing = await env.KV.get(`queue:${sessionId}`, "json");
  if (existing) return existing;
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const admitAt = Date.now() + delay;
  const entry = { queued: true, admitted: false, admitAt, delay };
  await env.KV.put(`queue:${sessionId}`, JSON.stringify(entry), { expirationTtl: 120 });
  return entry;
}
__name(enqueue, "enqueue");
async function checkQueue(env, sessionId) {
  const entry = await env.KV.get(`queue:${sessionId}`, "json");
  if (!entry) return { admitted: true };
  if (entry.admitted) return entry;
  if (Date.now() >= entry.admitAt) {
    const updated = { ...entry, admitted: true };
    await env.KV.put(`queue:${sessionId}`, JSON.stringify(updated), { expirationTtl: 120 });
    return updated;
  }
  return { ...entry, waitMs: entry.admitAt - Date.now() };
}
__name(checkQueue, "checkQueue");

// src/handlers/tickets.js
async function handleGetEvent(request, env, config) {
  const sessionId = getSessionId(request);
  if (sessionId) {
    await recordAction(env, sessionId, "event_view", Date.now());
    const queue = await enqueue(env, config, sessionId);
    if (!queue.admitted) {
      return jsonResponse({ queued: true, waitMs: queue.waitMs, admitAt: queue.admitAt });
    }
  }
  let count = 0, total = 0;
  try {
    const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
    const res = await counterStub.fetch("http://do/counter", {
      method: "POST",
      body: JSON.stringify({ action: "status" })
    });
    const data = await res.json();
    count = data.count ?? 0;
    total = data.total ?? 0;
  } catch (e) {
    return jsonResponse({
      event: eventInfo(),
      tickets_remaining: 0,
      tickets_total: 0,
      seats: [],
      not_initialized: true
    });
  }
  let totalBotTickets = 0;
  try {
    const sim = await env.KV.get("simulation", "json") || {};
    const botState = await getBotState(env, total, config, Date.now());
    totalBotTickets = botState.totalBotTickets;
  } catch (_) {
  }
  const takenSeats = await env.KV.get("taken_seats", "json") || [];
  const seats = buildSeatMap(total, takenSeats);
  return jsonResponse({
    event: eventInfo(),
    tickets_remaining: Math.max(0, count - totalBotTickets),
    tickets_total: total,
    seats
  });
}
__name(handleGetEvent, "handleGetEvent");
async function handleCheckoutInit(request, env, config) {
  const body = await request.json().catch(() => ({}));
  const { sessionId, seats, canvasFingerprint } = body;
  const ip = getIP(request);
  const ua = getUA(request);
  if (!sessionId || !seats?.length) {
    return jsonResponse({ error: "missing_fields" }, 400);
  }
  const binding = await validateSessionBinding(env, sessionId, ip, ua);
  if (!binding.valid) return jsonResponse({ error: binding.reason }, 401);
  if (binding.session.banned) {
    return jsonResponse({ error: "session_banned", anomalyScore: binding.session.anomalyScore }, 403);
  }
  const queue = await checkQueue(env, sessionId);
  if (!queue.admitted) {
    return jsonResponse({ queued: true, waitMs: queue.waitMs });
  }
  const deltas = [];
  if (binding.anomalyDelta > 0) deltas.push(binding.anomalyDelta);
  const fpResult = await checkFingerprint(env, config, sessionId, canvasFingerprint, request);
  if (fpResult.score > 0) deltas.push(fpResult.score);
  await recordAction(env, sessionId, "checkout_init", Date.now());
  const behResult = await analyzeSession(env, sessionId, config);
  if (behResult.suspicious) deltas.push(SCORE_DELTAS.behavioral_flag);
  if (deltas.length > 0) {
    const scoreResult = await applyScoreDeltas(env, config, sessionId, deltas);
    if (scoreResult?.banned) {
      return jsonResponse({ error: "session_banned", anomalyScore: scoreResult.anomalyScore }, 403);
    }
  }
  const { token, expires_in } = await issueCheckoutToken(env, config, sessionId, binding.session.accountId, seats);
  const captcha = await issueCaptcha(env, config);
  await logRequest(env, { type: "checkout_init", sessionId, ip, seats });
  return jsonResponse({ checkoutToken: token, expires_in, captcha });
}
__name(handleCheckoutInit, "handleCheckoutInit");
async function handleCheckoutComplete(request, env, config) {
  const body = await request.json().catch(() => ({}));
  const { sessionId, checkoutToken, captchaChallenge, captchaSolution, payment } = body;
  const ip = getIP(request);
  const ua = getUA(request);
  if (!sessionId || !checkoutToken) {
    return jsonResponse({ error: "missing_fields" }, 400);
  }
  const binding = await validateSessionBinding(env, sessionId, ip, ua);
  if (!binding.valid) return jsonResponse({ error: binding.reason }, 401);
  if (binding.session.banned) {
    return jsonResponse({ error: "session_banned", anomalyScore: binding.session.anomalyScore }, 403);
  }
  const deltas = [];
  if (binding.anomalyDelta > 0) deltas.push(binding.anomalyDelta);
  const honeypotTriggered = await checkHoneypot(env, sessionId, body);
  if (honeypotTriggered) {
    deltas.push(SCORE_DELTAS.honeypot_triggered);
    await applyScoreDeltas(env, config, sessionId, deltas);
    await logRequest(env, { type: "honeypot_triggered", sessionId, ip });
    return jsonResponse({ error: "checkout_failed", reason: "validation_error" }, 400);
  }
  const captchaResult = await validateCaptcha(env, config, captchaChallenge, captchaSolution);
  if (!captchaResult.valid) {
    await logRequest(env, { type: "captcha_fail", reason: captchaResult.reason, sessionId, ip });
    return jsonResponse({ error: "captcha_failed", reason: captchaResult.reason }, 400);
  }
  const tokenResult = await consumeCheckoutToken(env, checkoutToken, sessionId);
  if (!tokenResult.valid) {
    if (tokenResult.anomalyScore) deltas.push(tokenResult.anomalyScore);
    await applyScoreDeltas(env, config, sessionId, deltas);
    return jsonResponse({ error: tokenResult.reason }, 400);
  }
  await recordAction(env, sessionId, "checkout_complete", Date.now());
  const behResult = await analyzeSession(env, sessionId, config);
  if (behResult.suspicious) {
    deltas.push(SCORE_DELTAS.behavioral_flag);
    await logRequest(env, { type: "behavioral_flag", reasons: behResult.reasons, sessionId, ip });
  }
  if (!payment?.card_number || !payment?.expiry || !payment?.cvv) {
    return jsonResponse({ error: "payment_invalid" }, 400);
  }
  const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
  const res = await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({
      action: "decrement",
      amount: tokenResult.seats.length,
      accountId: tokenResult.accountId
    })
  });
  const result = await res.json();
  if (!result.ok) {
    return jsonResponse({ error: result.reason, remaining: result.remaining }, 409);
  }
  const takenSeats = await env.KV.get("taken_seats", "json") || [];
  takenSeats.push(...tokenResult.seats);
  await env.KV.put("taken_seats", JSON.stringify(takenSeats), { expirationTtl: 86400 });
  if (deltas.length > 0) {
    await applyScoreDeltas(env, config, sessionId, deltas);
  }
  const session = await getSession(env, sessionId);
  await logRequest(env, {
    type: "purchase_success",
    sessionId,
    accountId: tokenResult.accountId,
    seats: tokenResult.seats,
    ip,
    remaining: result.remaining,
    anomalyScore: session?.anomalyScore ?? 0
  });
  return jsonResponse({
    ok: true,
    confirmation: `CONF-${Date.now().toString(36).toUpperCase()}`,
    seats: tokenResult.seats,
    tickets_remaining: result.remaining,
    anomalyScore: session?.anomalyScore ?? 0
  });
}
__name(handleCheckoutComplete, "handleCheckoutComplete");
function eventInfo() {
  return {
    name: "TicketStorm Live \u2014 Sold Out Tour",
    venue: "The Concurrent Arena",
    date: "2025-12-31T21:00:00Z"
  };
}
__name(eventInfo, "eventInfo");
function buildSeatMap(total, takenSeats) {
  if (!total) return [];
  const takenSet = new Set(takenSeats);
  const seats = [];
  for (let i = 1; i <= total; i++) {
    const row = String.fromCharCode(65 + Math.floor((i - 1) / 10));
    const col = (i - 1) % 10 + 1;
    const id = `${row}${col}`;
    seats.push({ id, row, col, status: takenSet.has(id) ? "taken" : "available" });
  }
  return seats;
}
__name(buildSeatMap, "buildSeatMap");

// src/handlers/api.js
async function handleStatus(request, env, config) {
  let count = 0, total = 0, purchases = {};
  try {
    const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
    const res = await counterStub.fetch("http://do/counter", {
      method: "POST",
      body: JSON.stringify({ action: "status" })
    });
    ({ count, total, purchases } = await res.json());
  } catch (_) {
  }
  const sim = await env.KV.get("simulation", "json") || {};
  const nowMs = Date.now();
  const botState = await getBotState(env, total, config, nowMs);
  const humanPurchases = Math.max(0, total - count - botState.totalBotTickets);
  const elapsed = sim.startedAt ? nowMs - sim.startedAt : 0;
  const timeLeft = sim.startedAt ? Math.max(0, config.session_ttl_seconds * 1e3 - elapsed) : 0;
  return jsonResponse({
    simulation: {
      started_at: sim.startedAt,
      elapsed_ms: elapsed,
      time_left_ms: timeLeft,
      active: !!sim.startedAt
    },
    tickets: {
      total,
      remaining: Math.max(0, count - botState.totalBotTickets),
      taken_by_humans: humanPurchases,
      taken_by_bots: botState.totalBotTickets,
      sold_out: count === 0
    },
    config: {
      difficulty: config.difficulty,
      defender_bots: config.defender_bots_count,
      captcha_enabled: config.captcha_enabled,
      captcha_pow_zeros: config.captcha_pow_zeros,
      fingerprinting_enabled: config.fingerprinting_enabled,
      rate_limit_rps: config.rate_limit_requests_per_second,
      anomaly_ban_threshold: config.anomaly_ban_threshold,
      checkout_token_ttl: config.checkout_token_ttl_seconds
    },
    bot_activity: Object.entries(botState.botAccounts).filter(([, v]) => v.bought > 0).slice(0, 30).map(([id, v]) => ({ id: id.slice(0, 10) + "\u2026", type: v.type, bought: v.bought })),
    // Per-account purchases for scoreboard
    human_accounts: Object.entries(purchases).filter(([id]) => !id.startsWith("bot_")).map(([id, count2]) => ({ id: id.slice(0, 10) + "\u2026", bought: count2 }))
  });
}
__name(handleStatus, "handleStatus");
async function handleReset(request, env) {
  const body = await request.json().catch(() => ({}));
  const providedSecret = body.secret || request.headers.get("X-Reset-Secret") || "";
  const expectedSecret = env.RESET_SECRET || DEFAULTS.reset_secret;
  if (!safeEqual(providedSecret, expectedSecret)) {
    return jsonResponse({ error: "invalid_secret" }, 403);
  }
  const newConfig = { ...DEFAULTS, ...body.config || {} };
  await setConfig(env, newConfig);
  const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
  await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({ action: "reset" })
  });
  await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({ action: "init", amount: newConfig.tickets_total })
  });
  await counterStub.fetch("http://do/counter", {
    method: "POST",
    body: JSON.stringify({ action: "set_config", amount: newConfig.max_tickets_per_account })
  });
  await clearLogs(env);
  await env.KV.delete("taken_seats");
  await env.KV.delete("bot_schedule");
  const startedAt = Date.now();
  await env.KV.put("simulation", JSON.stringify({ startedAt }), {
    expirationTtl: newConfig.session_ttl_seconds + 300
  });
  await initBotSchedule(env, newConfig, startedAt);
  return jsonResponse({
    ok: true,
    message: "simulation reset",
    started_at: startedAt,
    config: newConfig
  });
}
__name(handleReset, "handleReset");
async function handleLogs(request, env, config) {
  const logs = await getLogs(env);
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 500);
  const type = url.searchParams.get("type");
  const filtered = type ? logs.filter((l) => l.type === type) : logs;
  const stats = filtered.reduce((acc, l) => {
    acc[l.type] = (acc[l.type] || 0) + 1;
    return acc;
  }, {});
  return jsonResponse({
    logs: filtered.slice(-limit).reverse(),
    // newest first
    total: filtered.length,
    stats
  });
}
__name(handleLogs, "handleLogs");
async function handleQueueStatus(request, env) {
  const sessionId = getSessionId(request) || new URL(request.url).searchParams.get("session");
  if (!sessionId) return jsonResponse({ error: "session_required" }, 400);
  const queue = await checkQueue(env, sessionId);
  return jsonResponse(queue);
}
__name(handleQueueStatus, "handleQueueStatus");
async function handleGetCaptcha(request, env, config) {
  const captcha = await issueCaptcha(env, config);
  if (!captcha) return jsonResponse({ enabled: false });
  return jsonResponse(captcha);
}
__name(handleGetCaptcha, "handleGetCaptcha");
async function handleGetHoneypot(request, env, config) {
  const sessionId = getSessionId(request);
  if (!sessionId) return jsonResponse({ error: "session_required" }, 400);
  const fields = await issueHoneypotConfig(env, sessionId);
  return jsonResponse({ fields });
}
__name(handleGetHoneypot, "handleGetHoneypot");
async function handleGetSession(request, env) {
  const sessionId = getSessionId(request);
  if (!sessionId) return jsonResponse({ error: "no_session" }, 400);
  const session = await getSession(env, sessionId);
  if (!session) return jsonResponse({ error: "session_not_found" }, 404);
  return jsonResponse({
    sessionId: session.sessionId,
    anomalyScore: session.anomalyScore,
    banned: session.banned,
    createdAt: session.createdAt
  });
}
__name(handleGetSession, "handleGetSession");
async function handleAdmin(request, env, config) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || request.headers.get("X-Reset-Secret") || "";
  const expectedSecret = env.RESET_SECRET || DEFAULTS.reset_secret;
  if (!safeEqual(secret, expectedSecret)) {
    return jsonResponse({ error: "invalid_secret" }, 403);
  }
  return jsonResponse({
    config,
    difficulty_presets: ["easy", "medium", "hard", "nightmare"]
  });
}
__name(handleAdmin, "handleAdmin");

// src/handlers/scoreboard.js
async function handleScoreboard(request, env) {
  const sessionId = getSessionId(request) || new URL(request.url).searchParams.get("session");
  const config = await getConfig(env);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = /* @__PURE__ */ __name(async (data) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}

`));
  }, "send");
  (async () => {
    try {
      for (let i = 0; i < 300; i++) {
        let count = 0, total = 0;
        try {
          const counterStub = env.TICKET_COUNTER.get(env.TICKET_COUNTER.idFromName("global"));
          const res = await counterStub.fetch("http://do/counter", {
            method: "POST",
            body: JSON.stringify({ action: "status" })
          });
          ({ count, total } = await res.json());
        } catch (_) {
        }
        const nowMs = Date.now();
        const botState = await getBotState(env, total, config, nowMs);
        const sim = await env.KV.get("simulation", "json") || {};
        const session = sessionId ? await getSession(env, sessionId) : null;
        const elapsed = sim.startedAt ? nowMs - sim.startedAt : 0;
        await send({
          ts: nowMs,
          tickets_remaining: Math.max(0, count - botState.totalBotTickets),
          tickets_total: total,
          bot_purchases: botState.totalBotTickets,
          human_purchases: Math.max(0, total - count - botState.totalBotTickets),
          elapsed_ms: elapsed,
          difficulty: config.difficulty,
          your_anomaly_score: session?.anomalyScore ?? null,
          your_banned: session?.banned ?? null,
          bot_feed: Object.entries(botState.botAccounts).filter(([, v]) => v.bought > 0).slice(0, 10).map(([id, v]) => ({ id: id.slice(0, 10) + "\u2026", type: v.type, bought: v.bought }))
        });
        await sleep(2e3);
      }
    } catch (_) {
    } finally {
      writer.close();
    }
  })();
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
__name(handleScoreboard, "handleScoreboard");
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
__name(sleep, "sleep");

// src/index.js
var src_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-FP, X-Reset-Secret",
          "Access-Control-Max-Age": "86400"
        }
      });
    }
    try {
      const config = await getConfig(env);
      const ip = getIP(request);
      const ua = getUA(request);
      const sessionId = getSessionId(request);
      const url = new URL(request.url);
      const path = url.pathname;
      if (path !== "/api/reset" && isDatacenterIP(ip)) {
        ctx.waitUntil(logRequest(env, { type: "blocked_datacenter_ip", ip, path }));
        if (sessionId) {
          ctx.waitUntil(applyScoreDeltas(env, config, sessionId, [SCORE_DELTAS.datacenter_ip]));
        }
        return jsonResponse({ error: "forbidden", reason: "datacenter_ip" }, 403);
      }
      if (request.method === "POST") {
        const rateResult = await checkRateLimit(env, config, ip, sessionId);
        if (rateResult.blocked) {
          ctx.waitUntil(logRequest(env, { type: "rate_limited", ip, reason: rateResult.reason, path }));
          if (sessionId) {
            ctx.waitUntil(applyScoreDeltas(env, config, sessionId, [SCORE_DELTAS.rate_limit_violation]));
          }
          return jsonResponse({ error: "rate_limited", retry_after_ms: rateResult.retryAfterMs }, 429);
        }
      }
      if (path === "/api/auth/register" && request.method === "POST")
        return handleRegister(request, env, config);
      if (path === "/api/auth/login" && request.method === "POST")
        return handleLogin(request, env, config);
      if (path === "/api/event" && request.method === "GET")
        return handleGetEvent(request, env, config);
      if (path === "/api/checkout/init" && request.method === "POST")
        return handleCheckoutInit(request, env, config);
      if (path === "/api/checkout/complete" && request.method === "POST")
        return handleCheckoutComplete(request, env, config);
      if (path === "/api/captcha" && request.method === "GET")
        return handleGetCaptcha(request, env, config);
      if (path === "/api/honeypot" && request.method === "GET")
        return handleGetHoneypot(request, env, config);
      if (path === "/api/status" && request.method === "GET")
        return handleStatus(request, env, config);
      if (path === "/api/reset" && request.method === "POST")
        return handleReset(request, env);
      if (path === "/api/logs" && request.method === "GET")
        return handleLogs(request, env, config);
      if (path === "/api/queue/status" && request.method === "GET")
        return handleQueueStatus(request, env);
      if (path === "/api/session" && request.method === "GET")
        return handleGetSession(request, env);
      if (path === "/events/scoreboard")
        return handleScoreboard(request, env);
      if (path === "/api/admin" && request.method === "GET")
        return handleAdmin(request, env, config);
      return jsonResponse({ error: "not_found" }, 404);
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: "internal_error", message: err.message }, 500);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-TfKpVX/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-TfKpVX/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  TicketCounter,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
