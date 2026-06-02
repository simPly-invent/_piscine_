/**
 * config.js — API endpoint with environment switcher.
 *
 * Two environments:
 *   - "competitive" → the live Cloudflare Worker (real bots, shared KV quota)
 *   - "local"       → wrangler dev on localhost:8787 (unlimited, private)
 *
 * The selected environment is stored in localStorage so it persists across
 * pages and reloads. A small switcher (injected below) lets you flip between
 * them from any page.
 */

const ENVIRONMENTS = {
  competitive: "https://ticketstorm.dbenaissi.workers.dev",
  local: "http://localhost:8787",
};

// Read selected env (default: competitive)
const CURRENT_ENV = localStorage.getItem("ts_env") || "competitive";

export const API_URL = ENVIRONMENTS[CURRENT_ENV] || ENVIRONMENTS.competitive;

export function setEnvironment(env) {
  localStorage.setItem("ts_env", env);
  location.reload();
}

// ── Inject the environment switcher into the page ─────────────────────────────
// Runs once on import. Adds a small fixed badge in the bottom-right corner.
if (typeof document !== "undefined") {
  const inject = () => {
    if (document.getElementById("env-switcher")) return;

    const isLocal = CURRENT_ENV === "local";
    const box = document.createElement("div");
    box.id = "env-switcher";
    box.style.cssText = `
      position: fixed; bottom: 12px; right: 12px; z-index: 9999;
      font-family: var(--font, monospace); font-size: 12px;
      background: #1a1a1a; border: 1px solid ${isLocal ? "#3498db" : "#e63946"};
      border-radius: 6px; padding: 8px 12px; color: #e8e8e8;
      box-shadow: 0 4px 12px rgba(0,0,0,.4); user-select: none;
    `;
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:8px;height:8px;border-radius:50%;background:${isLocal ? "#3498db" : "#e63946"};display:inline-block"></span>
        <span style="color:#888">ENV:</span>
        <strong style="color:${isLocal ? "#3498db" : "#e63946"}">${isLocal ? "LOCAL" : "COMPETITIVE"}</strong>
        <button id="env-toggle" style="
          margin-left:6px; background:#2e2e2e; border:1px solid #444;
          color:#e8e8e8; border-radius:4px; padding:2px 8px; cursor:pointer;
          font-family:inherit; font-size:11px;
        ">switch →</button>
      </div>
      <div style="color:#666;font-size:10px;margin-top:4px">${API_URL}</div>
    `;
    document.body.appendChild(box);

    document.getElementById("env-toggle").addEventListener("click", () => {
      setEnvironment(isLocal ? "competitive" : "local");
    });
  };

  if (document.body) inject();
  else document.addEventListener("DOMContentLoaded", inject);
}
