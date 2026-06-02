# TicketStorm ⚡

> A competitive bot-training platform: a fake ticketing site defended by real
> bot-detection systems.  Write a bot that grabs tickets before the defenders
> block you.

---

## Origin: from Codexion to TicketStorm

In **Codexion** (42 School multithreading project), multiple threads competed
for shared resources protected by mutexes and semaphores.  The question was:
*how do you coordinate concurrent access to a limited resource without race
conditions or starvation?*

**TicketStorm** asks the same question at web scale:

| Codexion              | TicketStorm                       |
|-----------------------|-----------------------------------|
| Threads               | HTTP clients / bots               |
| Mutex                 | Durable Object (atomic counter)   |
| Semaphore             | Rate limiter + queue              |
| Shared memory         | Cloudflare KV                     |
| Deadlock detection    | Anomaly scoring + auto-ban        |
| Dining philosophers   | N bots competing for 100 tickets  |

The platform is deployed on the edge (Cloudflare Workers) where *every request
is a potential race*.  Your bot must navigate 10 independent security layers to
win — the same problem your C code solved with `pthread_mutex_lock`, just with
HTTP headers and JSON instead of syscalls.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub                                    │
│  ┌──────────┐   push    ┌────────────────────────────────────┐  │
│  │  You /   │──────────▶│  GitHub Actions (deploy.yml)       │  │
│  │  Your    │           │  1. Run tests (vitest)             │  │
│  │  Bot     │           │  2. wrangler deploy → CF Worker    │  │
│  └──────────┘           │  3. Build frontend → GitHub Pages  │  │
│        ▲                │  4. POST /api/reset (fresh sim)    │  │
│        │                └────────────────────────────────────┘  │
│        │ HTTP                         │                          │
└────────┼─────────────────────────────┼──────────────────────────┘
         │                             │
         │              ┌──────────────▼──────────────┐
         │              │     Cloudflare Edge          │
         │              │                              │
         │   ┌──────────▼──────────────────────────┐  │
         └───│  Worker (src/index.js)               │  │
             │  ┌─ Rate Limiter                     │  │
             │  ├─ IP Reputation                    │  │
             │  ├─ Session Binding                  │  │
             │  └─ Router ──────────────────────┐  │  │
             │                                  │  │  │
             │  ┌─────────────────────────────┐ │  │  │
             │  │  Security Layers            │ │  │  │
             │  │  ├─ captcha.js (PoW)        │ │  │  │
             │  │  ├─ honeypot.js             │ │  │  │
             │  │  ├─ behavioral.js           │ │  │  │
             │  │  ├─ fingerprint.js          │ │  │  │
             │  │  ├─ token-rotation.js       │ │  │  │
             │  │  ├─ queue.js                │ │  │  │
             │  │  └─ anomaly-score.js        │ │  │  │
             │  └─────────────────────────────┘ │  │  │
             │                                  │  │  │
             │  ┌──────────────────────────┐    │  │  │
             │  │  Durable Object          │◀───┘  │  │
             │  │  TicketCounter (atomic)  │       │  │
             │  └──────────────────────────┘       │  │
             │                                     │  │
             │  ┌──────────────────────────┐       │  │
             │  │  Cloudflare KV           │       │  │
             │  │  sessions / rate-limits  │       │  │
             │  │  accounts / logs         │       │  │
             │  └──────────────────────────┘       │  │
             └─────────────────────────────────────┘  │
                                                       │
         ┌─────────────────────────────────────────────┘
         │   GitHub Pages (frontend/)
         │   index.html     — event page + seat map
         │   checkout.html  — PoW CAPTCHA + checkout
         │   scoreboard.html — SSE live scoreboard
         └──────────────────────────────────────────────
```

---

## Security Layers

Each layer is in its own file under `worker/src/security/`.  Read the source —
every file has comments explaining **what it does** and **how to bypass it**.

| Layer | File | What it detects |
|---|---|---|
| Rate limiting | `rate-limiter.js` | Too many requests per second (sliding window) |
| CAPTCHA | `captcha.js` | Proof-of-work: find SHA256 nonce with N leading zeros |
| Honeypot | `honeypot.js` | Bots that fill all form inputs including hidden ones |
| Behavioral | `behavioral.js` | Superhuman timing (< 200ms steps, zero jitter) |
| Fingerprinting | `fingerprint.js` | Canvas hash mismatch, missing browser headers |
| Token rotation | `token-rotation.js` | Expired or replayed checkout tokens |
| IP reputation | `ip-reputation.js` | Requests from datacenter CIDR ranges |
| Queue | `queue.js` | Randomised admission delay (waiting room) |
| Session binding | `session-binding.js` | IP or UA change mid-session |
| Anomaly score | `anomaly-score.js` | Composite 0–100 score; auto-ban above threshold |

---

## Checkout Flow (what your bot must automate)

```
POST /api/auth/register   → { accountId, sessionId }
      │
      ▼
GET  /api/event           → { seats[], tickets_remaining }
      │  (may return { queued: true, waitMs } — poll until admitted)
      ▼
GET  /api/queue/status    → { admitted: true }
      │
      ▼
POST /api/checkout/init   → { checkoutToken, expires_in: 30, captcha: { challenge, zeros } }
      │
      ▼
  [Solve PoW: find nonce where SHA256(challenge+nonce) starts with `zeros` zeros]
      │
      ▼
POST /api/checkout/complete
  Body: {
    sessionId,
    checkoutToken,          ← single-use, 30s TTL
    captchaChallenge,
    captchaSolution,        ← your computed nonce
    payment: { card_number, expiry, cvv, name },
    [honeypot fields]       ← GET /api/honeypot first, then skip those fields
  }
      │
      ▼
  { ok: true, confirmation, seats, tickets_remaining, anomalyScore }
```

**Authorization:** All requests after login must include `Authorization: Bearer {sessionId}`.

---

## Difficulty Levels

Set `difficulty` in `config.json` (or pass it in the `/api/reset` body).

| Setting | Rate limit | Bots | CAPTCHA zeros | Anomaly ban |
|---|---|---|---|---|
| `easy` | 20 req/s | 5 | 2 (~600 hashes) | 80 |
| `medium` | 10 req/s | 20 | 3 (~4 000 hashes) | 70 |
| `hard` | 5 req/s | 50 | 4 (~65 000 hashes) | 60 |
| `nightmare` | 2 req/s | 200 | 5 (~1 000 000 hashes) | 30 |

---

## Deploy (one-click via GitHub Actions)

### Prerequisites

1. A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. A GitHub repository (fork this one)

### Step 1 — Cloudflare setup

```bash
# Install wrangler
npm install -g wrangler
wrangler login

# Create the KV namespace
wrangler kv:namespace create TICKETSTORM_KV
# Copy the ID printed, paste it into worker/wrangler.toml

# Create a Durable Object namespace (needs Workers Paid plan, $5/month)
# This is required for atomic ticket counting — see wrangler.toml

# Set the reset secret
wrangler secret put RESET_SECRET
```

### Step 2 — GitHub Secrets

In your repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | From Cloudflare dash → My Profile → API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | From Cloudflare dash → right sidebar |
| `CF_WORKERS_SUBDOMAIN` | Your `*.workers.dev` subdomain (e.g. `myname`) |
| `RESET_SECRET` | Same value you set via `wrangler secret put` |

### Step 3 — Enable GitHub Pages

Repo → Settings → Pages → Source: **GitHub Actions**

### Step 4 — Push

```bash
git push origin main
```

The Actions workflow will:
1. Run the test suite
2. Deploy the Worker to Cloudflare
3. Inject the Worker URL into the frontend and deploy to GitHub Pages
4. Call `/api/reset` to start a fresh simulation

---

## Resetting a Simulation

```bash
# Full reset with default config
curl -X POST https://your-worker.workers.dev/api/reset \
  -H "Content-Type: application/json" \
  -d '{"secret": "your_reset_secret"}'

# Reset with custom config
curl -X POST https://your-worker.workers.dev/api/reset \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "your_reset_secret",
    "config": {
      "tickets_total": 50,
      "difficulty": "nightmare",
      "defender_bots_count": 100
    }
  }'
```

---

## Suggested Learning Path

```
easy → understand the flow → study /api/logs → improve → medium → hard → nightmare
```

**Week 1 — easy:**
- Write a simple bot that automates register → event → checkout → complete.
- Check `/api/logs` to see which requests are being flagged.
- Study `worker/src/security/` — understand each layer's source code.

**Week 2 — medium:**
- Add PoW CAPTCHA solving (hint: SHA-256 in a loop, ~4000 iterations expected).
- Add human-like delays between requests (Gaussian jitter, ~30% CV).
- Skip honeypot fields by parsing the `/api/honeypot` response.
- Use the `/events/scoreboard` SSE feed to monitor your anomaly score live.

**Week 3 — hard:**
- Pipeline accounts: register N accounts in parallel before the sim starts.
- Route traffic through residential proxies to bypass the IP reputation check.
- Optimise the PoW solver (WASM? Worker threads? Pre-solve?).

**Week 4 — nightmare:**
- 200 bots, 5-zero PoW, ban threshold at 30.
- You win if you get even 1 ticket. Seriously.

---

## Win Condition

A run is a **win** if your bot:
- Purchases at least one ticket
- Keeps its anomaly score below 50 throughout
- Does **not** get IP-banned before purchase

The scoreboard at `/scoreboard.html` shows your score in real-time.

---

## Ethical Notice

This platform exists **exclusively for educational purposes**: to study
concurrency, HTTP rate limiting, bot detection, and web security.

**Do not** apply techniques learned here against real ticketing systems
(Ticketmaster, StubHub, event organisers, etc.).  Doing so:
- Is illegal in most jurisdictions (CFAA, Computer Misuse Act, etc.)
- Harms real people trying to attend events
- Gets you banned and possibly prosecuted

The target of this project is the simulated platform hosted by **you**, for
your own learning.  Treat it like a CTF challenge: the skills transfer, the
target does not.

---

## File Structure

```
.
├── config.json                        # Simulation parameters
├── frontend/                          # GitHub Pages static site
│   ├── index.html                     # Event page + seat map
│   ├── checkout.html                  # PoW CAPTCHA + checkout form
│   ├── scoreboard.html                # Live SSE scoreboard
│   ├── confirm.html                   # Purchase confirmation
│   ├── css/style.css
│   └── js/
│       ├── config.js                  # Worker URL (injected at deploy)
│       ├── app.js                     # Event page logic
│       ├── checkout.js                # CAPTCHA solver + checkout pipeline
│       └── scoreboard.js              # SSE client
├── worker/                            # Cloudflare Worker (backend)
│   ├── wrangler.toml
│   ├── package.json
│   ├── vitest.config.js
│   └── src/
│       ├── index.js                   # Router + middleware
│       ├── config.js                  # Config with difficulty presets
│       ├── durable-objects/
│       │   └── ticket-counter.js      # Atomic ticket counter (DO)
│       ├── security/
│       │   ├── rate-limiter.js        # Sliding window rate limiting
│       │   ├── captcha.js             # Proof-of-work CAPTCHA
│       │   ├── honeypot.js            # Hidden form field detection
│       │   ├── behavioral.js          # Timing / jitter analysis
│       │   ├── fingerprint.js         # Canvas + header fingerprinting
│       │   ├── token-rotation.js      # Short-lived, single-use tokens
│       │   ├── ip-reputation.js       # Datacenter CIDR blocklist
│       │   ├── queue.js               # Virtual waiting room
│       │   ├── session-binding.js     # IP + UA binding per session
│       │   └── anomaly-score.js       # Composite scoring
│       ├── bots/
│       │   └── defender.js            # Deterministic bot simulation
│       ├── handlers/
│       │   ├── auth.js                # Register / login
│       │   ├── tickets.js             # Event info + checkout
│       │   ├── api.js                 # Status / reset / logs
│       │   ├── scoreboard.js          # SSE stream
│       │   └── shared.js              # jsonResponse, getIP, getUA
│       └── utils/
│           ├── crypto.js              # randomToken, sha256hex, verifyPoW
│           └── logger.js              # Ring-buffer request log
├── tests/
│   ├── ticket-counter.test.js         # Counter: no-negative, per-account limit
│   ├── rate-limiter.test.js           # Rate limit: sliding window correctness
│   └── token-expiry.test.js           # Token: single-use, TTL, session binding
└── .github/workflows/
    ├── deploy.yml                     # Full deploy + reset on push
    └── test.yml                       # Tests on PRs
```
