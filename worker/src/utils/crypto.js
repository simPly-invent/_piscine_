/**
 * crypto.js — token generation and hashing helpers.
 *
 * We use the Web Crypto API which is available natively in Cloudflare Workers
 * without any imports.  All tokens are cryptographically random — never
 * Math.random() — so they can't be predicted or brute-forced in the TTL window.
 */

/** Generate a URL-safe random token of the given byte length. */
export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 of a string, returned as a lowercase hex string. */
export async function sha256hex(text) {
  const encoded = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify a proof-of-work CAPTCHA solution.
 * The client must find `solution` such that SHA256(challenge + solution)
 * begins with `zeros` hex zeros.
 */
export async function verifyPoW(challenge, solution, zeros) {
  const hash = await sha256hex(challenge + solution);
  return hash.startsWith("0".repeat(zeros));
}

/** Constant-time string comparison to prevent timing attacks on secrets. */
export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
