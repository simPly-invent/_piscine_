/**
 * honeypot.js — hidden form field detection.
 *
 * HOW IT WORKS:
 * The checkout form contains several invisible fields (display:none / opacity:0
 * / off-screen positioning).  Human users never see or fill them; bots that
 * scrape the DOM and fill all inputs will populate them.
 *
 * The field names are randomised per session so the challenger cannot simply
 * skip a hardcoded field name.  The expected value is always the empty string.
 *
 * CHALLENGER HINT:
 * Before submitting a form, check every field for `visibility:hidden`,
 * `display:none`, `opacity:0`, `position:absolute` with negative offsets, or
 * `tabindex=-1`.  Also check `aria-hidden` and `data-honeypot` attributes.
 * If you find one, skip it.  Better yet: parse only the visible, interactive
 * inputs.
 */

import { randomToken } from "../utils/crypto.js";

// The names the frontend renders as honeypots (must match frontend/js/checkout.js)
export const HONEYPOT_FIELD_NAMES = ["email_confirm", "phone_verify", "address_check"];

/** Generate per-session honeypot field names and store expected values in KV. */
export async function issueHoneypotConfig(env, sessionId) {
  // Randomise the actual DOM names so they can't be hard-coded
  const fields = HONEYPOT_FIELD_NAMES.map((base) => `${base}_${randomToken(4)}`);
  await env.KV.put(`hp:${sessionId}`, JSON.stringify(fields), { expirationTtl: 3600 });
  return fields;
}

/** Return true (bot detected) if any honeypot field is non-empty. */
export async function checkHoneypot(env, sessionId, body) {
  const fields = await env.KV.get(`hp:${sessionId}`, "json");
  if (!fields) return false; // no honeypot config for this session

  for (const field of fields) {
    // Any truthy value means the bot filled a hidden field
    if (body[field] !== undefined && body[field] !== "") {
      return true;
    }
  }
  return false;
}
