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
    let expiresAt = Number(d.expires_at ?? d.expiresAt ?? d.expiry ?? d.expiryTime ?? 0);
    if (!token) throw new Error(`token response had no token field: ${Object.keys(d).join(",")}`);
    if (!expiresAt || expiresAt < Date.now()) expiresAt = Date.now() + 23 * 3600 * 1000;
    tokenCache = { token, expiresAt };
    return token;
  })();

  try { return await tokenInFlight; } finally { tokenInFlight = null; }
}

// ---- Tekion search ----------------------------------------------------------
async function searchRepairOrder(roNumber, { retryOn401 = true } = {}) {
  const token = await getToken();
  const res = await fetch(`${TEKION_BASE}/v4.0.0/repair-orders:search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      app_id: TEKION_APP_ID,
      Authorization: `Bearer ${token}`,
      dealer_id: TEKION_DEALER_ID,
    },
    body: JSON.stringify({
      filters: [{ field: "documentNumber", operator: "IN", values: [roNumber] }],
      pageSize: 1,
      sort: [{ field: "modifiedTime", order: "DESC" }],
    }),
  });

  if (res.status === 401 && retryOn401) {
    tokenCache = { token: null, expiresAt: 0 };
    return searchRepairOrder(roNumber, { retryOn401: false });
  }
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`tekion ${res.status}`), { status: res.status, body: text.slice(0, 300) });
  return JSON.parse(text);
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

app.post("/ro-status", async (req, res) => {
  const auth = req.get("authorization") || "";
  if (!WEBHOOK_SECRET || auth !== `Bearer ${WEBHOOK_SECRET}`) return res.status(401).json({ found: false, reason: "unauthorized" });

  const roNumber = String(req.body?.ro_number ?? "").replace(/\D/g, "");
  if (!roNumber) return res.json({ found: false, reason: "missing_ro_number", dealer: DEALER_NAME });

  try {
    const body = await searchRepairOrder(roNumber);
    const ro = body?.data?.results?.[0];
    if (!ro) return res.json({ found: false, reason: "no_match", ro_number: roNumber, dealer: DEALER_NAME });

    const promise = (ro.schedule || []).find((s) => s.type === "PROMISE_TIME")?.value;
    return res.json({
      found: true,
      ro_number: ro.documentNumber,
      status: ro.status,
      spoken: SPOKEN[ro.status] ?? "being worked on; the service advisor can give you the details",
      tag_number: ro.tagNumber ?? "",
      promise_time_spoken: spokenTime(promise),
      dealer: DEALER_NAME,
    });
  } catch (err) {
    console.error("[ro-status]", err.message, err.body ?? "");
    // Never surface a status code to the agent; the pathway routes found=false to a calm fallback.
    return res.json({ found: false, reason: "lookup_failed", ro_number: roNumber, dealer: DEALER_NAME });
  }
});

app.listen(PORT, () => console.log(`${DEALER_NAME} RO status service listening on ${PORT} -> ${TEKION_BASE}`));
