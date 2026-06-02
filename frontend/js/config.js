/**
 * config.js — API URL injected at deploy time by GitHub Actions.
 * The workflow replaces __WORKER_URL__ with the actual Cloudflare Worker URL.
 */
export const API_URL = "https://ticketstorm.dbenaissi.workers.dev";
