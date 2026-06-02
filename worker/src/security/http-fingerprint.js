/**
 * http-fingerprint.js — TLS/HTTP client fingerprinting.
 *
 * This is the #1 defense real ticketing platforms (DataDome, Akamai,
 * PerimeterX, Cloudflare Bot Management) rely on. The idea: a client's
 * low-level signature reveals whether it's a real browser or an HTTP library
 * spoofing a User-Agent — BEFORE you even look at behaviour.
 *
 * TWO LAYERS:
 *
 * 1. TLS FINGERPRINT (JA3/JA4)
 *    The TLS ClientHello (cipher suites, extensions, curves, their order) is
 *    unique to the TLS stack. Chrome's BoringSSL, Python's OpenSSL, Go's crypto/tls
 *    all produce DIFFERENT JA3 hashes. You can spoof the User-Agent string but
 *    NOT the TLS handshake — unless you use a browser-grade TLS library
 *    (curl-impersonate, utls in Go, tls-client in Python).
 *    Cloudflare exposes this as request.cf.botManagement.ja3Hash (enterprise).
 *    We read it if present; on free tier / local it's absent, so we skip it.
 *
 * 2. HTTP HEADER CONSISTENCY (works everywhere)
 *    A real Chrome ALWAYS sends a coherent set of headers together:
 *      sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform (Client Hints)
 *      sec-fetch-site, sec-fetch-mode, sec-fetch-dest    (Fetch Metadata)
 *      accept, accept-language, accept-encoding
 *    A Python `requests`/`aiohttp` client that sets a Chrome User-Agent but
 *    omits these is instantly inconsistent → flagged. The User-Agent is the
 *    EASIEST thing to fake and the LEAST trustworthy signal on its own.
 *
 * CHALLENGER HINT:
 *   - To beat the header check: send the FULL coherent header set a real Chrome
 *     sends, with matching values (UA version must match sec-ch-ua version).
 *   - To beat the TLS check (on real platforms): use curl-impersonate or
 *     tls-client (Python) / utls (Go) so your ClientHello matches a real browser.
 *     A plain `requests`/`aiohttp` TLS handshake has a Python JA3 — dead giveaway.
 */

// Known HTTP-library User-Agents — an instant, heavy flag.
const LIBRARY_UA_PATTERNS = [
  "python-requests", "python-urllib", "aiohttp", "httpx", "curl/",
  "wget/", "go-http-client", "node-fetch", "axios/", "java/", "okhttp",
  "libwww-perl", "scrapy", "postmanruntime", "insomnia",
];

export function checkHttpFingerprint(request, config) {
  if (!config.http_fingerprint_enabled) return { score: 0, reasons: [], ja3: null };

  const h = (name) => request.headers.get(name) || "";
  const ua = h("user-agent").toLowerCase();
  const reasons = [];
  let score = 0;

  // ── TLS JA3 (if Cloudflare provides it) ─────────────────────────────────────
  const ja3 = request.cf?.botManagement?.ja3Hash || null;
  // We don't maintain a good/bad JA3 allowlist here (that needs a real corpus),
  // but if Cloudflare's own bot score says it's a bot, fold that in.
  const cfScore = request.cf?.botManagement?.score; // 1 (bot) … 99 (human)
  if (typeof cfScore === "number" && cfScore < 30) {
    score += 20;
    reasons.push(`cf_bot_score_${cfScore}`);
  }

  // ── 1. Outright HTTP-library UA ──────────────────────────────────────────────
  if (LIBRARY_UA_PATTERNS.some((p) => ua.includes(p))) {
    score += 40;
    reasons.push("http_library_user_agent");
    // No point checking browser-consistency on a library UA.
    return { score, reasons, ja3 };
  }

  // Does the UA *claim* to be a Chromium-based browser?
  const claimsChromium = ua.includes("chrome/") || ua.includes("chromium") || ua.includes("edg/");
  const claimsBrowser  = claimsChromium || ua.includes("firefox/") || ua.includes("safari/");

  // ── 2. Client Hints consistency (Chromium) ───────────────────────────────────
  // Real Chrome/Edge ALWAYS send sec-ch-ua on every request. Absence while
  // claiming Chrome = a library spoofing the UA.
  if (claimsChromium && !h("sec-ch-ua")) {
    score += 25;
    reasons.push("missing_sec_ch_ua");
  }

  // ── 3. Fetch Metadata consistency ────────────────────────────────────────────
  // Browsers attach sec-fetch-* to every fetch/navigation. Libraries don't.
  if (claimsBrowser && !h("sec-fetch-mode")) {
    score += 20;
    reasons.push("missing_sec_fetch");
  }

  // ── 4. Accept-Language ───────────────────────────────────────────────────────
  // Browsers always send a language preference; many bots omit it.
  if (claimsBrowser && !h("accept-language")) {
    score += 10;
    reasons.push("missing_accept_language");
  }

  // ── 5. Accept value mismatch ─────────────────────────────────────────────────
  // `requests`/`curl` default to Accept: */* . A real browser sends a rich,
  // type-specific Accept. */* + browser UA = inconsistent.
  const accept = h("accept");
  if (claimsBrowser && (accept === "*/*" || accept === "")) {
    score += 15;
    reasons.push("generic_accept_with_browser_ua");
  }

  // ── 6. UA / sec-ch-ua version coherence ──────────────────────────────────────
  // If both are present, the major Chrome version should appear in sec-ch-ua.
  const secChUa = h("sec-ch-ua");
  if (claimsChromium && secChUa) {
    const uaVer = ua.match(/chrome\/(\d+)/)?.[1];
    if (uaVer && !secChUa.includes(uaVer)) {
      score += 20;
      reasons.push("ua_version_mismatch");
    }
  }

  return { score, reasons, ja3 };
}
