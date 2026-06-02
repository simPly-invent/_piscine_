"""
TicketStorm Bot — Python asyncio
Pipeline: register → event → checkout_init (+ PoW) → checkout_complete
"""

import asyncio
import aiohttp
import hashlib
import random
import string
import time
import json
from concurrent.futures import ThreadPoolExecutor

# ── Config ────────────────────────────────────────────────────────────────────
API       = "http://localhost:8787"   # local wrangler dev (or the live worker URL)
ACCOUNTS  = 5      # comptes lancés en parallèle
MAX_SEATS = 2      # max par compte (limite serveur)

# Human-like delay between pipeline steps (ms). The behavioral defense flags
# any step faster than `behavioral_min_action_ms` (500ms in nightmare) and also
# flags *too-regular* timing (low variance). So we use a base delay + gaussian
# jitter to look human. Set to 0 to go full-speed (and accept the behavioral
# flag) when you only care about winning the ticket race, not the anomaly score.
STEP_DELAY_MS = 650          # base delay; must exceed the difficulty's min
STEP_JITTER   = 0.35         # ±35% gaussian jitter → variance looks biological

# Proxies résidentiels (laisser vide = pas de proxy)
# Format: "http://user:pass@ip:port"
PROXIES = []

# Pool de threads pour le PoW CPU-bound
_executor = ThreadPoolExecutor(max_workers=ACCOUNTS)

# ── Utils ─────────────────────────────────────────────────────────────────────

def random_email():
    slug = "".join(random.choices(string.ascii_lowercase, k=8))
    domain = random.choice(["gmail.com", "yahoo.com", "hotmail.com"])
    return f"{slug}@{domain}"

async def human_delay():
    """Sleep a human-like, jittered amount to beat the behavioral timing check."""
    if STEP_DELAY_MS <= 0:
        return
    base = STEP_DELAY_MS / 1000
    # gaussian jitter around the base, clamped so it never dips below the base
    ms = max(base, random.gauss(base, base * STEP_JITTER))
    await asyncio.sleep(ms)

# A COHERENT Chrome 120 header set. The HTTP-fingerprint defense flags any
# inconsistency, so every field here is internally consistent:
#   - User-Agent says Chrome/120  →  sec-ch-ua MUST also say version 120
#   - Client Hints (sec-ch-ua*) present, as a real Chromium always sends them
#   - Fetch Metadata (sec-fetch-*) present
#   - Accept is type-specific, NOT the bare "*/*" that requests/curl default to
#   - accept-language present
#
# NOTE: this defeats the *HTTP* fingerprint only. A real platform also checks
# the *TLS* fingerprint (JA3) — aiohttp's TLS ClientHello is still "Python".
# To beat that you'd swap aiohttp for a browser-impersonating TLS client
# (e.g. `tls-client`, `curl_cffi`/curl-impersonate). See README.
_CHROME_VERSION = "120"
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    f"(KHTML, like Gecko) Chrome/{_CHROME_VERSION}.0.0.0 Safari/537.36"
)

def headers(session_id=None):
    h = {
        "Content-Type": "application/json",
        "User-Agent": _USER_AGENT,
        # Client Hints — version must match the UA above
        "sec-ch-ua": f'"Not_A Brand";v="8", "Chromium";v="{_CHROME_VERSION}", '
                     f'"Google Chrome";v="{_CHROME_VERSION}"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        # Fetch Metadata
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        # Type-specific Accept (a browser never sends a bare */* here)
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
    }
    if session_id:
        h["Authorization"] = f"Bearer {session_id}"
    return h

# ── PoW solver (CPU-bound → thread pool) ──────────────────────────────────────

def _solve_pow_sync(challenge: str, zeros: int) -> str:
    """Tourne dans un thread séparé pour ne pas bloquer la boucle asyncio."""
    target = "0" * zeros
    nonce = 0
    while True:
        h = hashlib.sha256(f"{challenge}{nonce}".encode()).hexdigest()
        if h.startswith(target):
            return str(nonce)
        nonce += 1

async def solve_pow(challenge: str, zeros: int) -> str:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, _solve_pow_sync, challenge, zeros)

# ── API calls ─────────────────────────────────────────────────────────────────

async def register(session: aiohttp.ClientSession, proxy=None) -> dict:
    email = random_email()
    payload = {
        "username": email.split("@")[0],
        "email": email,
        "password": "B0tP@ss2025!",
    }
    async with session.post(f"{API}/api/auth/register",
                            json=payload,
                            headers=headers(),
                            proxy=proxy) as r:
        data = await r.json()
    if "sessionId" not in data:
        raise RuntimeError(f"register failed: {data}")
    return data  # { accountId, sessionId }


async def get_event(session: aiohttp.ClientSession,
                    session_id: str, proxy=None) -> dict:
    """Retourne la réponse event. Gère la queue automatiquement."""
    while True:
        async with session.get(f"{API}/api/event",
                               headers=headers(session_id),
                               proxy=proxy) as r:
            data = await r.json()

        if data.get("queued"):
            wait = data.get("waitMs", 3000) / 1000
            await asyncio.sleep(wait + 0.1)
            continue

        return data


async def get_honeypot_fields(session: aiohttp.ClientSession,
                               session_id: str, proxy=None) -> list:
    """Récupère les noms des champs honeypot à NE PAS remplir."""
    async with session.get(f"{API}/api/honeypot",
                           headers=headers(session_id),
                           proxy=proxy) as r:
        data = await r.json()
    return data.get("fields", [])


async def checkout_init(session: aiohttp.ClientSession,
                        session_id: str, seats: list, proxy=None) -> dict:
    payload = {"sessionId": session_id, "seats": seats}
    async with session.post(f"{API}/api/checkout/init",
                            json=payload,
                            headers=headers(session_id),
                            proxy=proxy) as r:
        data = await r.json()
    if "checkoutToken" not in data:
        raise RuntimeError(f"checkout_init failed: {data}")
    return data  # { checkoutToken, expires_in, captcha }


async def checkout_complete(session: aiohttp.ClientSession,
                             session_id: str,
                             token: str,
                             challenge: str,
                             solution: str,
                             honeypot_fields: list,
                             proxy=None) -> dict:
    payload = {
        "sessionId": session_id,
        "checkoutToken": token,
        "captchaChallenge": challenge,
        "captchaSolution": solution,
        "payment": {
            "card_number": "4111111111111111",
            "expiry": "12/26",
            "cvv": "123",
            "name": "John Doe",
        },
        # Honeypot fields laissés VIDES intentionnellement
        **{field: "" for field in honeypot_fields},
    }
    async with session.post(f"{API}/api/checkout/complete",
                             json=payload,
                             headers=headers(session_id),
                             proxy=proxy) as r:
        return await r.json()


async def get_anomaly_score(session: aiohttp.ClientSession,
                             session_id: str, proxy=None) -> int:
    async with session.get(f"{API}/api/session",
                           headers=headers(session_id),
                           proxy=proxy) as r:
        data = await r.json()
    return data.get("anomalyScore", -1)

# ── Pipeline complet pour un compte ──────────────────────────────────────────

async def run_account(session: aiohttp.ClientSession,
                      account_num: int, proxy=None) -> dict:
    t0 = time.perf_counter()
    log = lambda msg: print(f"[acc#{account_num:02d}] {msg}")

    try:
        # 1. Register
        acc = await register(session, proxy)
        sid = acc["sessionId"]
        log(f"registered → {sid[:12]}…")

        await human_delay()  # look human: pause before browsing

        # 2. Get event + honeypot fields en parallèle
        event_task    = asyncio.create_task(get_event(session, sid, proxy))
        honeypot_task = asyncio.create_task(get_honeypot_fields(session, sid, proxy))
        event, honeypot_fields = await asyncio.gather(event_task, honeypot_task)

        seats = [s["id"] for s in event.get("seats", [])
                 if s["status"] == "available"][:MAX_SEATS]
        if not seats:
            log("no seats available")
            return {"account": account_num, "ok": False, "reason": "no_seats"}
        log(f"seats selected: {seats}")

        await human_delay()  # pause before opening checkout

        # 3. checkout/init
        co = await checkout_init(session, sid, seats, proxy)
        token   = co["checkoutToken"]
        captcha = co.get("captcha")

        # 4. Résoudre PoW dans un thread (non-bloquant). The PoW itself takes
        #    time, which conveniently doubles as a human-like gap before submit.
        if captcha:
            log(f"solving PoW (zeros={captcha['zeros']})…")
            solution = await solve_pow(captcha["challenge"], captcha["zeros"])
            log(f"PoW solved → nonce={solution}")
        else:
            solution  = None
            captcha   = {"challenge": None}
            await human_delay()  # no PoW to absorb time → add a manual pause

        # 5. checkout/complete
        result = await checkout_complete(
            session, sid, token,
            captcha["challenge"], solution,
            honeypot_fields, proxy
        )

        elapsed = (time.perf_counter() - t0) * 1000
        score   = result.get("anomalyScore", "?")
        ok      = result.get("ok", False)

        if ok:
            log(f"✓ TICKETS SECURED {result.get('seats')} "
                f"| anomaly={score} | {elapsed:.0f}ms")
        else:
            log(f"✗ failed: {result.get('error')} | anomaly={score} | {elapsed:.0f}ms")

        return {"account": account_num, "ok": ok, "result": result, "ms": elapsed}

    except Exception as e:
        log(f"exception: {e}")
        return {"account": account_num, "ok": False, "reason": str(e)}


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    print(f"TicketStorm Bot — {ACCOUNTS} accounts — API: {API}")
    print("=" * 60)

    # Répartit les proxies en round-robin si disponibles
    def proxy_for(i):
        if not PROXIES:
            return None
        return PROXIES[i % len(PROXIES)]

    connector = aiohttp.TCPConnector(
        limit=ACCOUNTS * 2,   # connexions simultanées max
        ttl_dns_cache=300,    # cache DNS pour éviter les lookups répétés
    )

    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [
            run_account(session, i, proxy_for(i))
            for i in range(ACCOUNTS)
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    # Résumé
    print("=" * 60)
    won     = [r for r in results if isinstance(r, dict) and r.get("ok")]
    failed  = [r for r in results if isinstance(r, dict) and not r.get("ok")]
    crashed = [r for r in results if isinstance(r, Exception)]

    print(f"✓ Tickets secured : {len(won)}")
    print(f"✗ Failed          : {len(failed)}")
    print(f"💥 Crashed         : {len(crashed)}")

    if won:
        avg_ms = sum(r["ms"] for r in won) / len(won)
        print(f"⏱  Avg time/win   : {avg_ms:.0f}ms")


if __name__ == "__main__":
    asyncio.run(main())
