// Dealer configuration: service-defaults.json (shared by every store) overlaid with one store's
// operational settings. The store settings come from, in order of precedence:
//   1. DEALER_CONFIG_JSON   env var holding a JSON object (edit in the hosting dashboard, no deploy of code)
//   2. DEALER_CONFIG_PATH   env var pointing at a JSON file
//   3. ./dealer-config.json next to this file
// Only operational keys belong here (dealer id, hours, booking policy, menu tweaks). Anything a caller
// can ask about lives in the store's Bland knowledge base and pathway variables.

import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

function loadStoreConfig() {
  const raw = process.env.DEALER_CONFIG_JSON?.trim();
  if (raw) {
    try { return { source: "env:DEALER_CONFIG_JSON", data: JSON.parse(raw) }; }
    catch (e) { console.error("[config] DEALER_CONFIG_JSON is not valid JSON, falling back to file:", e.message); }
  }
  const file = process.env.DEALER_CONFIG_PATH || path.join(here, "dealer-config.json");
  return fs.existsSync(file) ? { source: file, data: readJson(file) } : { source: "defaults-only", data: {} };
}

// Menu = defaults, then per-key overrides, minus excluded keys, plus store-specific additions.
function buildMenu(defaults, store) {
  const overrides = store.menuOverrides ?? {};
  const exclude = new Set(store.menuExclude ?? []);
  const base = (store.menu ?? defaults.menu ?? []).filter((m) => !exclude.has(m.key)).map((m) => ({ requiresAdvisor: false, type: "DEFAULT", ...m, ...(overrides[m.key] ?? {}) }));
  for (const add of store.menuAdd ?? []) if (!exclude.has(add.key)) base.push({ requiresAdvisor: false, type: "DEFAULT", ...add });
  return base;
}

export function loadDealerConfig() {
  const defaults = readJson(path.join(here, "service-defaults.json"));
  const { source, data: store } = loadStoreConfig();
  const merged = deepMerge(defaults, store);
  merged.services = { ...merged.services, menu: buildMenu(defaults.services, { ...defaults.services, ...store.services }) };
  delete merged.services.menuOverrides; delete merged.services.menuExclude; delete merged.services.menuAdd;
  merged.dealerId = process.env.TEKION_DEALER_ID || merged.dealerId || null;
  merged.dealerName = process.env.DEALER_NAME || merged.dealerName || "the dealership";
  merged._source = source;
  for (const k of Object.keys(merged)) if (k.startsWith("_") && k !== "_source") delete merged[k];
  return merged;
}
