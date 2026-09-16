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
    let expiresAt = Number(d.expire_on ?? d.expires_at ?? d.expiresAt ?? d.expiry ?? 0);
    if (expiresAt && expiresAt < 1e12) expiresAt *= 1000; // seconds -> ms
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

async function tekionGet(path, { retryOn401 = true, version = "v4.0.0" } = {}) {
  const token = await getToken();
  const res = await fetch(`${TEKION_BASE}/${version}${path}`, {
    headers: { "Content-Type": "application/json", app_id: TEKION_APP_ID, Authorization: `Bearer ${token}`, dealer_id: TEKION_DEALER_ID },
  });
  if (res.status === 401 && retryOn401) { tokenCache = { token: null, expiresAt: 0 }; return tekionGet(path, { retryOn401: false, version }); }
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`tekion ${res.status}`), { status: res.status, body: text.slice(0, 300) });
  return JSON.parse(text);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- Phone -> vehicle index, built from Appointment Search (v3.1.0) ---------------
// Appointment Search has no phone filter, but each appointment carries customer.phones and
// vehicle {vin, year, make, model}. We pull the last APPT_LOOKBACK_DAYS of appointments and
// index phone -> [{vin, vehicle, customer, appointmentDateTime}]. Rebuilt every 3 minutes.
const APPT_LOOKBACK_DAYS = Number(process.env.APPT_LOOKBACK_DAYS || 21);
let apptIndex = { builtAt: 0, byPhone: new Map(), stats: {} };
let apptInFlight = null;

function spokenVehicle(v) {
  return [v?.year, v?.make, v?.model].filter(Boolean).join(" ");
}

async function buildApptIndex() {
  if (Date.now() - apptIndex.builtAt < 3 * 60 * 1000) return apptIndex;
  if (apptInFlight) return apptInFlight;
  apptInFlight = (async () => {
    const now = Date.now();
    const DAY = 86400000;
    const byPhone = new Map();
    let pages = 0, appts = 0;
    const chunks = [];
    // Tekion caps each query at a 7-day span, so walk back in 7-day windows (newest first).
    const windows = [[now, now + 2 * DAY]];
    for (let d = 0; d < APPT_LOOKBACK_DAYS; d += 7) windows.push([now - Math.min(d + 7, APPT_LOOKBACK_DAYS) * DAY, now - d * DAY]);
    for (const [from, to] of windows) {
      let nextFetchKey = null, chunkPages = 0, chunkAppts = 0, error = null;
      try {
        do {
          const qs = new URLSearchParams({ appointmentStartTime: String(from), appointmentEndTime: String(to) });
          if (nextFetchKey) qs.set("nextFetchKey", nextFetchKey);
          const r = await tekionGet(`/appointments?${qs}`, { version: "v3.1.0" });
          const data = r?.data ?? [];
          for (const a of data) {
            appts++; chunkAppts++;
            const vin = a?.vehicle?.vin;
            if (!vin) continue;
            const phones = new Set([...(a?.customer?.phones ?? []), ...(a?.deliveryContact?.phones ?? [])].map((ph) => normalizePhone(ph.number)).filter(Boolean));
            for (const ph of phones) {
              const list = byPhone.get(ph) ?? [];
              if (!list.some((e) => e.vin === vin)) list.push({ vin, vehicle: a.vehicle, customer: { firstName: a.customer?.firstName, lastName: a.customer?.lastName }, appointmentDateTime: a.appointmentDateTime, appointmentNumber: a.appointmentNumber });
              byPhone.set(ph, list);
            }
          }
          nextFetchKey = r?.meta?.nextFetchKey || null;
          pages++; chunkPages++;
        } while (nextFetchKey && chunkPages < 20);
      } catch (e) {
        error = e.body ? e.body.slice(0, 160) : e.message;
      }
      chunks.push({ days_ago: [Math.round((now - to) / DAY), Math.round((now - from) / DAY)], pages: chunkPages, appointments: chunkAppts, error });
    }
    const firstError = chunks.find((c) => c.error)?.error ?? null;
    apptIndex = { builtAt: Date.now(), byPhone, stats: { pages, appointments: appts, phones: byPhone.size, lookback_days: APPT_LOOKBACK_DAYS, chunks, firstError } };
    console.log("[appt-index]", JSON.stringify(apptIndex.stats));
    return apptIndex;
  })();
  try { return await apptInFlight; } finally { apptInFlight = null; }
}

// Open ROs for a set of VINs.
async function openRosForVins(vins) {
  if (!vins.length) return [];
  const r = await tekionSearch({
    filters: [
      { field: "vin", operator: "IN", values: vins },
      { field: "status", operator: "IN", values: OPEN_STATUSES },
    ],
    pageSize: 10,
    sort: [{ field: "creationTime", order: "DESC" }],
  });
  return r?.data?.results ?? [];
}

// Phone lookup: text search first (cheap), then the appointment index -> VIN -> open RO.
async function findByPhone(phone10) {
  const r = await searchByPhone(phone10);
  const direct = r?.data?.results ?? [];
  if (direct.length) return { results: direct, via: "text_search", vehicles: {} };

  const idx = await buildApptIndex();
  const entries = idx.byPhone.get(phone10) ?? [];
  if (!entries.length) return { results: [], via: "appointment_index", vehicles: {} };
  const ros = await openRosForVins(entries.map((e) => e.vin));
  // Attach the vehicle description from the appointment so the agent can say "your 2022 Nissan Rogue".
  const vehicles = Object.fromEntries(entries.map((e) => [e.vin, e]));
  return { results: ros, via: "appointment_index", vehicles };
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

function describe(ro, veh) {
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
    vehicle_spoken: veh ? spokenVehicle(veh.vehicle) : "",
    vin: ro.vin ?? veh?.vin ?? "",
    customer_first_name: veh?.customer?.firstName ?? "",
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
    let results, via = "ro_number", vehicles = {};
    if (roNumber) results = (await searchByRoNumber(roNumber))?.data?.results ?? [];
    else ({ results, via, vehicles } = await findByPhone(phone));
    base.via = via;
    // RO search results reference the vehicle by link only; match back to the appointment vehicle when there is exactly one.
    const vehFor = (ro) => vehicles[ro.vin] ?? (Object.keys(vehicles).length === 1 ? Object.values(vehicles)[0] : undefined);

    if (results.length === 0) return res.json({ ...base, found: false, match_count: 0, reason: "no_match", ro_number: roNumber, phone });

    if (results.length === 1 || roNumber) {
      return res.json({ ...base, found: true, match_count: 1, ...describe(results[0], vehFor(results[0])) });
    }

    // Several open ROs on one phone (two cars, or a household). Hand back enough to disambiguate.
    const options = results.slice(0, 3).map((ro) => describe(ro, vehFor(ro)));
    return res.json({
      ...base,
      found: false,
      match_count: results.length,
      reason: "multiple_matches",
      options_spoken: options.map((o) => o.vehicle_spoken ? `the ${o.vehicle_spoken}` : `one opened ${o.opened_spoken} ending in ${o.ro_last4.split("").join(" ")}`).join(", and "),
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
  try {
    const idx = await buildApptIndex();
    out.appointment_index = idx.stats;
    // Probe: take a real phone from the index and prove phone -> VIN -> open RO end to end.
    for (const [ph, entries] of idx.byPhone) {
      const ros = await openRosForVins(entries.map((e) => e.vin));
      if (ros.length) { out.probe = { phone_masked: ph.slice(0, 3) + "*****" + ph.slice(-2), vehicle: spokenVehicle(entries[0].vehicle), open_ro: ros[0].documentNumber, status: ros[0].status }; break; }
    }
    if (!out.probe) out.probe = "no indexed phone currently has an open RO";
  } catch (e) {
    out.appointment_index = { ok: false, error: e.message, tekion_status: e.status, body: e.body };
  }
  const p = normalizePhone(phone);
  if (p) {
    try {
      const { results, via } = await findByPhone(p);
      out.phone_search = { ok: true, phone: p, via, matches: results.length, ro_numbers: results.map((x) => x.documentNumber) };
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
