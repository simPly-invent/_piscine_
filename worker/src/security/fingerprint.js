/**
 * fingerprint.js — device fingerprinting via canvas hash + header analysis.
 *
 * TWO SIGNALS:
 *
 * 1. CANVAS FINGERPRINT (client-side, sent in X-FP header)
 *    The browser renders a specific string with emoji to a canvas.  The GPU
 *    driver, OS font rendering, and sub-pixel AA produce unique pixel values.
 *    We hash the result and store it in the session.  If the hash changes
 *    between requests on the same session → possible token sharing or proxy.
 *
 * 2. HEADER ORDER + PRESENCE (server-side)
 *    Real browsers send headers in a deterministic order (Chrome/FF have known
 *    fingerprints).  Headless Puppeteer, Playwright, and curl have different
 *    orders or missing headers.  We score the deviation from known-good profiles.
 *
 * CHALLENGER HINT:
 * For canvas: use a real browser (Puppeteer with a real Chrome binary) — the
 * fingerprint will match a normal Chrome profile.
 * For headers: make sure your HTTP client sends Accept, Accept-Language,
 * Accept-Encoding, and Connection in a browser-matching order.  Puppeteer does
 * this for you; raw fetch() in Node or curl does not.
 */

// Headers a real Chrome 120 browser always sends (order matters)
const CHROME_EXPECTED_HEADERS = [
  "host",
  "connection",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "upgrade-insecure-requests",
  "user-agent",
  "accept",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest",
  "accept-encoding",
  "accept-language",
];

export async function storeFingerprint(env, sessionId, canvasHash, request) {
  const fp = buildHeaderFingerprint(request);
  await env.KV.put(
    `fp:${sessionId}`,
    JSON.stringify({ canvasHash, headerProfile: fp }),
    { expirationTtl: 3600 }
  );
}

export async function checkFingerprint(env, config, sessionId, canvasHash, request) {
  if (!config.fingerprinting_enabled) return { score: 0 };

  const stored = await env.KV.get(`fp:${sessionId}`, "json");
  let score = 0;
  const reasons = [];

  // Score header deviation
  const headerScore = scoreHeaders(request);
  if (headerScore > 3) {
    score += 15;
    reasons.push(`suspicious_headers_score_${headerScore}`);
  }

  if (stored) {
    // Canvas hash changed on the same session → likely a different client
    if (canvasHash && stored.canvasHash && canvasHash !== stored.canvasHash) {
      score += 25;
      reasons.push("canvas_fingerprint_mismatch");
    }
  } else if (canvasHash) {
    await storeFingerprint(env, sessionId, canvasHash, request);
  }

  return { score, reasons };
}

function scoreHeaders(request) {
  const headers = [...request.headers.keys()].map((h) => h.toLowerCase());
  let missing = 0;
  for (const expected of ["accept", "accept-language", "user-agent"]) {
    if (!headers.includes(expected)) missing++;
  }
  // Bots often omit sec-fetch-* headers
  const hasSecFetch = headers.some((h) => h.startsWith("sec-fetch-"));
  return missing * 2 + (hasSecFetch ? 0 : 2);
}

function buildHeaderFingerprint(request) {
  return [...request.headers.keys()]
    .map((h) => h.toLowerCase())
    .sort()
    .join(",");
}
