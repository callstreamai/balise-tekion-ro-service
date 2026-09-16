// Bland webhook backend for Balise Nissan of Warwick: Tekion repair order status.
//
// One endpoint Bland calls during the live call:
//   POST /ro-status   Authorization: Bearer <WEBHOOK_SECRET>   { "ro_number": "0142368" }
//   -> { found, ro_number, status, spoken, tag_number, promise_time_spoken, dealer }
//
// The service owns the Tekion token exchange (form-encoded POST, 24h expiry,
// 20 tokens per 15 minutes) and caches the token in memory.

import express from "express";

const {
  TEKION_BASE = "https://api-sandbox.tekioncloud.com/openapi",
  TEKION_APP_ID,
  TEKION_SECRET_KEY,
  TEKION_DEALER_ID,
  WEBHOOK_SECRET,
  DEALER_NAME = "Balise Nissan of Warwick",
  PORT = 10000,
} = process.env;

for (const k of ["TEKION_APP_ID", "TEKION_SECRET_KEY", "TEKION_DEALER_ID", "WEBHOOK_SECRET"]) {
  if (!process.env[k]) console.warn(`[startup] missing env var ${k}`);
}

// Plain-language meaning per Tekion RO status enum. This is the only text the agent speaks about status.
const SPOKEN = {
  UNASSIGNED: "checked in and in the queue; work has not started yet",
  PARTIALLY_ASSIGNED: "checked in and in the queue; work has not started yet",
  TECH_ASSIGNED: "assigned to a technician; work has not started yet",
  IN_PROGRESS: "a technician is working on the vehicle right now",
  HOLD: "on hold, which usually means the shop is waiting on parts or an approval; the service advisor can explain what it is waiting on",
  READY_FOR_INVOICE: "the work is finished and the paperwork is being finalized",
  INVOICED: "the work is complete and the vehicle is ready for pickup",
  CLOSED: "this repair order has already been closed out",
  VOIDED: "there is no active repair order under that number",
};

// ---- Tekion token cache -------------------------------------------------
let tokenCache = { token: null, expiresAt: 0 };
let tokenInFlight = null;

async function getToken() {
  if (tokenCache.token && tokenCache.expiresAt - Date.now() > 10 * 60 * 1000) return tokenCache.token;
  if (tokenInFlight) return tokenInFlight; // coalesce concurrent calls so we never burn the rate limit

  tokenInFlight = (async () => {
    const res = await fetch(`${TEKION_BASE}/public/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ app_id: TEKION_APP_ID, secret_key: TEKION_SECRET_KEY }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`token ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const d = json.data ?? json;
    // Tekion's doc shows "data": {...} without naming the fields; accept the common spellings.
    const token = d.access_token ?? d.accessToken ?? d.token ?? d.bearerToken;
    console.log("[tekion] token response fields:", Object.keys(d).join(","), "| token field found:", Boolean(token));
    let expiresAt = Number(d.expires_at ?? d.expiresAt ?? d.expiry ?? d.expiryTime ?? 0);
    if (!token) throw new Error(`token response had no token field: ${Object.keys(d).join(",")}`);
    if (!expiresAt || expiresAt < Date.now()) expiresAt = Date.now() + 23 * 3600 * 1000;
    tokenCache = { token, expiresAt };
    return token;
  })();

  try { return await tokenInFlight; } finally { tokenInFlight = null; }
}

// ---- Tekion search ----------------------------------------------------------
const OPEN_STATUSES = ["UNASSIGNED", "PARTIALLY_ASSIGNED", "TECH_ASSIGNED", "IN_PROGRESS", "HOLD", "READY_FOR_INVOICE", "INVOICED"];

async function tekionSearch(body, { retryOn401 = true } = {}) {
  const token = await getToken();
  const res = await fetch(`${TEKION_BASE}/v4.0.0/repair-orders:search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      app_id: TEKION_APP_ID,
      Authorization: `Bearer ${token}`,
      dealer_id: TEKION_DEALER_ID,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && retryOn401) {
    tokenCache = { token: null, expiresAt: 0 };
    return tekionSearch(body, { retryOn401: false });
  }
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`tekion ${res.status}`), { status: res.status, body: text.slice(0, 300) });
  return JSON.parse(text);
}

function searchByRoNumber(roNumber) {
  return tekionSearch({
    filters: [{ field: "documentNumber", operator: "IN", values: [roNumber] }],
    pageSize: 1,
    sort: [{ field: "modifiedTime", order: "DESC" }],
  });
}

// Phone lookup: Tekion exposes no phone filter, so this relies on the CUSTOMER free-text index
// containing the phone number. Verify in sandbox. Only open ROs are returned so a caller with
// history gets their current visit, not last year's oil change.
function searchByPhone(phone10) {
  return tekionSearch({
    textSearch: { text: phone10, fields: ["CUSTOMER"] },
    filters: [{ field: "status", operator: "IN", values: OPEN_STATUSES }],
    pageSize: 10,
    sort: [{ field: "creationTime", order: "DESC" }],
  });
}

// Normalize anything (E.164 caller ID, spoken digits, formatted) to 10 US digits.
function normalizePhone(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : "";
}

function spokenDate(epochMs) {
  if (!epochMs || epochMs <= 0) return "";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }).format(new Date(epochMs));
}

function spokenTime(epochMs) {
  if (!epochMs || epochMs <= 0) return "";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
  }).format(new Date(epochMs));
}

// ---- HTTP -------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => res.json({ ok: true, dealer: DEALER_NAME, tekion_base: TEKION_BASE }));

function describe(ro) {
  const promise = (ro.schedule || []).find((s) => s.type === "PROMISE_TIME")?.value;
  const checkin = (ro.schedule || []).find((s) => s.type === "CHECKIN_TIME")?.value || ro.creationTime;
  return {
    ro_number: ro.documentNumber,
    ro_last4: String(ro.documentNumber ?? "").slice(-4),
    status: ro.status,
    spoken: SPOKEN[ro.status] ?? "being worked on; the service advisor can give you the details",
    tag_number: ro.tagNumber ?? "",
    opened_spoken: spokenDate(checkin),
    promise_time_spoken: spokenTime(promise),
  };
}

// POST /ro-status  { ro_number } OR { phone }
// found=true  + match_count=1 : one RO, fully described
// found=false + match_count>1 : several open ROs on this phone; ask for the RO number (or pick by date)
// found=false + match_count=0 : nothing; reason tells you why
app.post("/ro-status", async (req, res) => {
  const auth = req.get("authorization") || "";
  if (!WEBHOOK_SECRET || auth !== `Bearer ${WEBHOOK_SECRET}`) {
    // Shape-only diagnostics. Never logs the token itself.
    console.warn("[auth] 401", JSON.stringify({
      header_present: auth.length > 0,
      header_len: auth.length,
      expected_len: `Bearer ${WEBHOOK_SECRET ?? ""}`.length,
      starts_with_bearer: auth.startsWith("Bearer "),
      bearer_count: (auth.match(/Bearer/gi) || []).length,
      trailing_whitespace: /\s$/.test(auth),
      looks_base64: /^Bearer [A-Za-z0-9+/]+=*$/.test(auth) && auth.length !== `Bearer ${WEBHOOK_SECRET ?? ""}`.length,
      secret_configured: Boolean(WEBHOOK_SECRET),
    }));
    return res.status(401).json({ found: false, match_count: 0, reason: "unauthorized" });
  }

  const roNumber = String(req.body?.ro_number ?? "").replace(/\D/g, "");
  const phone = normalizePhone(req.body?.phone);
  const base = { dealer: DEALER_NAME, lookup: roNumber ? "ro_number" : phone ? "phone" : "none" };

  if (!roNumber && !phone) return res.json({ ...base, found: false, match_count: 0, reason: "missing_input" });

  try {
    const body = roNumber ? await searchByRoNumber(roNumber) : await searchByPhone(phone);
    const results = body?.data?.results ?? [];

    if (results.length === 0) return res.json({ ...base, found: false, match_count: 0, reason: "no_match", ro_number: roNumber, phone });

    if (results.length === 1 || roNumber) {
      return res.json({ ...base, found: true, match_count: 1, ...describe(results[0]) });
    }

    // Several open ROs on one phone (two cars, or a household). Hand back enough to disambiguate.
    const options = results.slice(0, 3).map(describe);
    return res.json({
      ...base,
      found: false,
      match_count: results.length,
      reason: "multiple_matches",
      options_spoken: options.map((o) => `one opened ${o.opened_spoken} ending in ${o.ro_last4.split("").join(" ")}`).join(", and "),
      options,
    });
  } catch (err) {
    console.error("[ro-status]", err.message, err.body ?? "");
    return res.json({ ...base, found: false, match_count: 0, reason: "lookup_failed" });
  }
});

// Self-check: proves Render -> Tekion connectivity without depending on Bland. Logs only shapes, never secrets.
async function selfCheck(phone) {
  const out = { tekion_base: TEKION_BASE, dealer_id: TEKION_DEALER_ID, app_id_set: Boolean(TEKION_APP_ID), secret_set: Boolean(TEKION_SECRET_KEY) };
  try {
    tokenCache = { token: null, expiresAt: 0 };
    const t = await getToken();
    out.token = { ok: true, length: t.length, expires_in_min: Math.round((tokenCache.expiresAt - Date.now()) / 60000) };
  } catch (e) {
    out.token = { ok: false, error: e.message };
    return out;
  }
  try {
    const r = await tekionSearch({ filters: [{ field: "status", operator: "IN", values: OPEN_STATUSES }], pageSize: 3, sort: [{ field: "creationTime", order: "DESC" }] });
    const results = r?.data?.results ?? [];
    out.open_ro_search = { ok: true, total: r?.meta?.totalCount ?? null, sample_ro_numbers: results.map((x) => x.documentNumber), sample_statuses: results.map((x) => x.status) };
  } catch (e) {
    out.open_ro_search = { ok: false, error: e.message, tekion_status: e.status, body: e.body };
  }
  const p = normalizePhone(phone);
  if (p) {
    try {
      const r = await searchByPhone(p);
      const results = r?.data?.results ?? [];
      out.phone_search = { ok: true, phone: p, matches: results.length, ro_numbers: results.map((x) => x.documentNumber) };
    } catch (e) {
      out.phone_search = { ok: false, error: e.message, tekion_status: e.status, body: e.body };
    }
  }
  return out;
}

// GET /diag?phone=4015290445  (protected by the same webhook secret)
app.get("/diag", async (req, res) => {
  const auth = req.get("authorization") || "";
  if (!WEBHOOK_SECRET || auth !== `Bearer ${WEBHOOK_SECRET}`) return res.status(401).json({ reason: "unauthorized" });
  res.json(await selfCheck(req.query.phone));
});

app.listen(PORT, () => {
  console.log(`${DEALER_NAME} RO status service listening on ${PORT} -> ${TEKION_BASE}`);
  selfCheck(process.env.SELFCHECK_PHONE || "4015290445")
    .then((r) => console.log("[selfcheck]", JSON.stringify(r)))
    .catch((e) => console.error("[selfcheck] crashed", e.message));
});
