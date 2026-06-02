/**
 * defender.js — deterministic defender bot simulation.
 *
 * WHY DETERMINISTIC?
 * Cloudflare Workers are stateless and short-lived.  We can't run N concurrent
 * async loops.  Instead, we pre-generate a complete timeline of bot actions at
 * simulation start and store it in KV.  On each status query we replay the
 * timeline up to "now" and compute the resulting state.
 *
 * This gives the same statistical behaviour as real concurrent bots (Poisson
 * distributed inter-arrival times, human-like jitter) without needing any
 * long-running process — exactly the kind of constraint-driven design you'd
 * encounter writing a scheduler in C.
 *
 * BOT PROFILES:
 *   "fast"    — near-instant responses, likely to buy if tickets remain
 *   "slow"    — 2–5s per step, careful shopper
 *   "clumsy"  — occasionally fails CAPTCHA on purpose, adds noise
 *
 * Profile mix scales with difficulty.
 *
 * CHALLENGER HINT:
 * The bot schedule is available at /api/logs — you can see exactly when
 * competitor bots are scheduled to buy.  Use this to time your purchases
 * just before the biggest bot waves hit.
 */

import { randomToken } from "../utils/crypto.js";

// Poisson inter-arrival: expected ms between attempts per bot
const PROFILE_DELAYS = {
  fast:   { min: 800,  max: 2000 },
  slow:   { min: 2000, max: 5000 },
  clumsy: { min: 1200, max: 3500 },
};

const DIFFICULTY_PROFILES = {
  easy:      { fast: 0.1, slow: 0.7, clumsy: 0.2 },
  medium:    { fast: 0.3, slow: 0.5, clumsy: 0.2 },
  hard:      { fast: 0.5, slow: 0.3, clumsy: 0.2 },
  nightmare: { fast: 0.7, slow: 0.2, clumsy: 0.1 },
};

// Realistic fake data pools for bot accounts
const FIRST_NAMES = ["Alice","Bob","Carol","Dave","Eve","Frank","Grace","Heidi","Ivan","Judy"];
const LAST_NAMES  = ["Smith","Jones","Williams","Brown","Davis","Miller","Wilson","Moore","Taylor","Anderson"];
const DOMAINS     = ["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com"];

function fakeName() {
  return `${FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]} ` +
         `${LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]}`;
}

function fakeEmail(name) {
  const slug = name.toLowerCase().replace(" ", ".") + Math.floor(Math.random() * 999);
  return `${slug}@${DOMAINS[Math.floor(Math.random() * DOMAINS.length)]}`;
}

/**
 * Generate the complete timeline for all bots and store in KV.
 *
 * Each bot's purchase attempts are spread across a "drain window"
 * (config.bot_drain_seconds). The swarm is sized so that, collectively, it can
 * consume the ENTIRE pool by the end of that window — so if the human does
 * nothing, the bots take everything. The drain window scales with difficulty:
 * easy gives the player ~10 min, nightmare ~12 s.
 *
 * Bots start at staggered times within the window (not all at once) so the
 * pool drains progressively rather than instantly — this is the gap a fast,
 * well-timed human bot must exploit to grab tickets before they run out.
 */
export async function initBotSchedule(env, config, simStartMs) {
  const count       = config.defender_bots_count;
  const profiles    = DIFFICULTY_PROFILES[config.difficulty] || DIFFICULTY_PROFILES.medium;
  const maxTickets  = config.max_tickets_per_account;
  const drainMs     = (config.bot_drain_seconds ?? 180) * 1000;
  const failRate    = config.clumsy_fail_rate ?? 0.25;

  const bots = [];

  for (let i = 0; i < count; i++) {
    const roll = Math.random();
    let type;
    if (roll < profiles.fast)                       type = "fast";
    else if (roll < profiles.fast + profiles.slow)  type = "slow";
    else                                            type = "clumsy";

    const name      = fakeName();
    const email     = fakeEmail(name);
    const ua        = randomUserAgent();
    const accountId = `bot_${randomToken(8)}`;

    // Each bot enters at a random point within the drain window. Faster bots
    // tend to arrive earlier; slow bots later. This staggering is what creates
    // the progressive drain (and the window the human can race into).
    const arrivalBias = type === "fast" ? 0.5 : type === "slow" ? 1.0 : 0.75;
    const firstAttempt = simStartMs + Math.random() * drainMs * arrivalBias;

    // Per-bot attempt spacing: scaled so the swarm empties the pool by drainMs.
    const baseDelays = PROFILE_DELAYS[type];
    const speedScale = drainMs / 180000; // normalise against the 3-min baseline
    const minGap = Math.max(50, baseDelays.min * speedScale);
    const maxGap = Math.max(120, baseDelays.max * speedScale);

    const actions = [];
    let t = firstAttempt;
    let purchased = 0;

    while (t < simStartMs + drainMs * 1.2 && purchased < maxTickets) {
      const failCaptcha = type === "clumsy" && Math.random() < failRate;
      actions.push({ t: Math.round(t), failCaptcha });
      t += randInt(minGap, maxGap);
      if (!failCaptcha) purchased++;
    }

    bots.push({ accountId, name, email, ua, type, actions, ticketsBought: 0 });
  }

  await env.KV.put("bot_schedule", JSON.stringify({ bots, generatedAt: simStartMs }), {
    expirationTtl: config.session_ttl_seconds + 60,
  });

  return bots.length;
}

/**
 * Compute the current state of all bots (how many tickets they've bought) by
 * replaying the schedule up to `nowMs`.
 *
 * Returns { totalBotTickets, botAccounts } where botAccounts is a map of
 * accountId → ticketsBought (for the scoreboard).
 */
export async function getBotState(env, ticketsAvailableAtStart, config, nowMs) {
  const data = await env.KV.get("bot_schedule", "json");
  if (!data) return { totalBotTickets: 0, botAccounts: {} };

  const maxPerAccount = config.max_tickets_per_account;

  // Flatten all successful attempts up to nowMs into a single timeline, then
  // replay in chronological order so the drain is time-accurate (a bot that
  // attempts at t=5s gets a ticket before one attempting at t=8s, regardless
  // of array position).
  const events = [];
  for (const bot of data.bots) {
    for (const action of bot.actions) {
      if (action.t > nowMs) break;       // actions are time-ordered per bot
      if (action.failCaptcha) continue;  // deliberate miss — no purchase
      events.push({ t: action.t, accountId: bot.accountId, type: bot.type });
    }
  }
  events.sort((a, b) => a.t - b.t);

  let ticketsLeft = ticketsAvailableAtStart;
  const botAccounts = {};

  for (const ev of events) {
    if (ticketsLeft <= 0) break;
    const acc = botAccounts[ev.accountId] || { bought: 0, type: ev.type };
    if (acc.bought >= maxPerAccount) continue;
    acc.bought++;
    ticketsLeft--;
    botAccounts[ev.accountId] = acc;
  }

  const totalBotTickets = Object.values(botAccounts).reduce((s, v) => s + v.bought, 0);
  return { totalBotTickets, botAccounts };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Realistic-looking UA strings so bots don't trigger the UA header check
const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

function randomUserAgent() {
  return UAS[Math.floor(Math.random() * UAS.length)];
}
