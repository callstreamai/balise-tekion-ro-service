// Bland webhook backend for Balise Nissan of Warwick on Tekion.
//
//   POST /ro-status        repair order status by RO number or phone (see below)
//   POST /schedule/*       scheduling, rescheduling, cancellation (see scheduling.js)
//   GET  /health           liveness
//   GET  /diag, /diag/matches, /schedule/catalog   protected diagnostics
//
// All POST endpoints require  Authorization: Bearer <WEBHOOK_SECRET>.
// The service owns the Tekion token exchange (tekion.js) and never logs credentials.

import express from "express";
import { tekion, getToken, resetToken, TEKION_BASE, tokenState } from "./tekion.js";
import { buildApptIndex, vehiclesForPhone, normalizePhone, spokenVehicle, startRefreshLoop, getIndex } from "./appointment-index.js";
import { schedulingRouter, loadCatalog, catalog, config } from "./scheduling.js";

const { TEKION_APP_ID, TEKION_SECRET_KEY, TEKION_DEALER_ID, WEBHOOK_SECRET, PORT = 10000 } = process.env;
const DEALER_NAME = config.dealerName;

for (const k of ["TEKION_APP_ID", "TEKION_SECRET_KEY", "TEKION_DEALER_ID", "WEBHOOK_SECRET"]) {
  if (!process.env[k]) console.warn(`[startup] missing env var ${k}`);
}
console.log("[config]", JSON.stringify({ source: config._source, dealer: config.dealerName, dealerId: config.dealerId, timezone: config.timezone, menu_items: config.services.menu.length }));

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
const OPEN_STATUSES = ["UNASSIGNED", "PARTIALLY_ASSIGNED", "TECH_ASSIGNED", "IN_PROGRESS", "HOLD", "READY_FOR_INVOICE", "INVOICED"];

const roSearch = (body) => tekion.post("/repair-orders:search", body, "v4.0.0");
const searchByRoNumber = (roNumber) => roSearch({ filters: [{ field: "documentNumber", operator: "IN", values: [roNumber] }], pageSize: 1, sort: [{ field: "modifiedTime", order: "DESC" }] });
const searchByPhone = (phone10) => roSearch({ textSearch: { text: phone10, fields: ["CUSTOMER"] }, filters: [{ field: "status", operator: "IN", values: OPEN_STATUSES }], pageSize: 10, sort: [{ field: "creationTime", order: "DESC" }] });

async function openRosForVins(vins) {
  if (!vins.length) return [];
  const r = await roSearch({ filters: [{ field: "vin", operator: "IN", values: vins }, { field: "status", operator: "IN", values: OPEN_STATUSES }], pageSize: 10, sort: [{ field: "creationTime", order: "DESC" }] });
  return r?.data?.results ?? [];
}

// Phone lookup: text search first (cheap), then the appointment index -> VIN -> open RO.
async function findByPhone(phone10) {
  const direct = (await searchByPhone(phone10))?.data?.results ?? [];
  if (direct.length) return { results: direct, via: "text_search", vehicles: {} };
  await buildApptIndex();
  const entries = vehiclesForPhone(phone10);
  if (!entries.length) return { results: [], via: "appointment_index", vehicles: {} };
  const ros = await openRosForVins(entries.map((e) => e.vin));
  return { results: ros, via: "appointment_index", vehicles: Object.fromEntries(entries.map((e) => [e.vin, e])) };
}

const NY = "America/New_York";
const spokenDate = (ms) => (ms > 0 ? new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: NY }).format(new Date(ms)) : "");
const spokenTime = (ms) => (ms > 0 ? new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: NY }).format(new Date(ms)) : "");

function describe(ro, veh) {
  const promise = (ro.schedule || []).find((s) => s.type === "PROMISE_TIME")?.value;
  const checkin = (ro.schedule || []).find((s) => s.type === "CHECKIN_TIME")?.value || ro.creationTime;
  return {
    ro_number: ro.documentNumber, ro_last4: String(ro.documentNumber ?? "").slice(-4), status: ro.status,
    spoken: SPOKEN[ro.status] ?? "being worked on; the service advisor can give you the details",
    tag_number: ro.tagNumber ?? "", opened_spoken: spokenDate(checkin), promise_time_spoken: spokenTime(promise),
    vehicle_spoken: veh ? spokenVehicle(veh.vehicle) : "", vin: ro.vin ?? veh?.vin ?? "", customer_first_name: veh?.customer?.firstName ?? "",
  };
}

// ---- HTTP -------------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "64kb" }));

function auth(req, res, next) {
  const hdr = req.get("authorization") || "";
  if (WEBHOOK_SECRET && hdr === `Bearer ${WEBHOOK_SECRET}`) return next();
  // Shape-only diagnostics. Never logs the token itself.
console.warn("[auth] 401", JSON.stringify({ path: req.path, header_present: hdr.length > 0, header_len: hdr.length, expected_len: `Bearer ${WEBHOOK_SECRET ?? ""}`.length, starts_with_bearer: hdr.startsWith("Bearer "), secret_configured: Boolean(WEBHOOK_SECRET) }));
  return res.status(401).json({ ok: false, found: false, match_count: 0, reason: "unauthorized" });
}

app.get("/health", (_req, res) => res.json({ ok: true, dealer: DEALER_NAME, tekion_base: TEKION_BASE, catalog_loaded: catalog.loadedAt > 0, token_cached: tokenState().cached }));

app.post("/ro-status", auth, async (req, res) => {
  const roNumber = String(req.body?.ro_number ?? "").replace(/\D/g, "");
  const phone = normalizePhone(req.body?.phone);
  const base = { dealer: DEALER_NAME, lookup: roNumber ? "ro_number" : phone ? "phone" : "none" };
  if (!roNumber && !phone) return res.json({ ...base, found: false, match_count: 0, reason: "missing_input" });
  try {
    let results, via = "ro_number", vehicles = {};
    if (roNumber) results = (await searchByRoNumber(roNumber))?.data?.results ?? [];
    else ({ results, via, vehicles } = await findByPhone(phone));
    base.via = via;
    const vehFor = (ro) => vehicles[ro.vin] ?? (Object.keys(vehicles).length === 1 ? Object.values(vehicles)[0] : undefined);
    if (results.length === 0) return res.json({ ...base, found: false, match_count: 0, reason: "no_match", ro_number: roNumber, phone });
    if (results.length === 1 || roNumber) return res.json({ ...base, found: true, match_count: 1, ...describe(results[0], vehFor(results[0])) });
    const options = results.slice(0, 3).map((ro) => describe(ro, vehFor(ro)));
    return res.json({
      ...base, found: false, match_count: results.length, reason: "multiple_matches",
      options_spoken: options.map((o) => (o.vehicle_spoken ? `the ${o.vehicle_spoken}` : `one opened ${o.opened_spoken} ending in ${o.ro_last4.split("").join(" ")}`)).join(", and "),
      options,
    });
  } catch (err) {
    console.error("[ro-status]", err.message, err.body ?? "");
    return res.json({ ...base, found: false, match_count: 0, reason: "lookup_failed" });
  }
});

app.use("/schedule", schedulingRouter(auth));

// Self-check: proves Render -> Tekion connectivity without depending on Bland. Logs only shapes, never secrets.
async function selfCheck(phone) {
  const out = { tekion_base: TEKION_BASE, dealer_id: TEKION_DEALER_ID, app_id_set: Boolean(TEKION_APP_ID), secret_set: Boolean(TEKION_SECRET_KEY) };
  try { resetToken(); const t = await getToken(); out.token = { ok: true, length: t.length, expires_in_min: Math.round((tokenState().expiresAt - Date.now()) / 60000) }; }
  catch (e) { out.token = { ok: false, error: e.message }; return out; }
  try {
    const r = await roSearch({ filters: [{ field: "status", operator: "IN", values: OPEN_STATUSES }], pageSize: 3, sort: [{ field: "creationTime", order: "DESC" }] });
    const results = r?.data?.results ?? [];
    out.open_ro_search = { ok: true, total: r?.meta?.totalCount ?? null, sample_ro_numbers: results.map((x) => x.documentNumber), sample_statuses: results.map((x) => x.status) };
  } catch (e) { out.open_ro_search = { ok: false, error: e.message, tekion_status: e.status, body: e.body }; }
  try { const idx = await buildApptIndex(); out.appointment_index = idx.stats; } catch (e) { out.appointment_index = { ok: false, error: e.message }; }
  try {
    const c = await loadCatalog(true);
    out.catalog = { shops: c.shops.length, transportation: c.transportation.map((t) => t.name), advisors: c.advisors.length, opcodes: c.opcodes.length, custom_concern: c.customConcern?.opcode ?? null, menu_resolved: c.menu.filter((m) => m.opcode).length, menu_unresolved: c.menu.filter((m) => !m.opcode).map((m) => m.key), error: c.error };
  } catch (e) { out.catalog = { ok: false, error: e.message }; }
  const p = normalizePhone(phone);
  if (p) {
    try { const { results, via } = await findByPhone(p); out.phone_search = { ok: true, via, matches: results.length }; }
    catch (e) { out.phone_search = { ok: false, error: e.message, tekion_status: e.status }; }
  }
  return out;
}

// GET /diag/matches?limit=3 (protected): open ROs resolvable from a phone in the appointment index, for test-call setup.
app.get("/diag/matches", auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 3, 10);
  await buildApptIndex();
  const matches = []; let checked = 0;
  for (const [ph, entries] of getIndex().byPhone) {
    if (matches.length >= limit || checked >= 60) break;
    checked++;
    try {
      const vins = [...new Set(entries.map((e) => e.vin).filter(Boolean))];
      const ros = await openRosForVins(vins);
      for (const ro of ros) { const veh = entries.find((e) => e.vin === ro.vin) ?? entries[0]; matches.push({ ro_number: ro.documentNumber, status: ro.status, phone: ph, vehicle: spokenVehicle(veh?.vehicle), customer_first_name: veh?.customer?.firstName ?? "", appointment: spokenDate(veh?.appointmentDateTime) }); }
    } catch { /* skip */ }
  }
  console.log(`[diag] matches requested: ${matches.length} returned after checking ${checked} phones`);
  res.json({ dealer: DEALER_NAME, checked_phones: checked, matches });
});

// GET /diag/upcoming?limit=3 (protected): phones with an upcoming appointment, for scheduling test-call setup.
app.get("/diag/upcoming", auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 3, 10);
  await buildApptIndex();
  const now = Date.now(), out = [];
  for (const [ph, entries] of getIndex().byPhone) {
    for (const e of entries) if (Number(e.appointmentDateTime) > now && !/cancel/i.test(e.status ?? "")) out.push({ phone: ph, appointment: spokenTime(Number(e.appointmentDateTime)), vehicle: spokenVehicle(e.vehicle), first_name: e.customer?.firstName ?? "", status: e.status });
    if (out.length >= limit) break;
  }
  res.json({ dealer: DEALER_NAME, upcoming: out.slice(0, limit) });
});

app.get("/diag", auth, async (req, res) => res.json(await selfCheck(req.query.phone)));

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`${DEALER_NAME} service listening on ${PORT} -> ${TEKION_BASE}`);
    selfCheck(process.env.SELFCHECK_PHONE || "").then((r) => console.log("[selfcheck]", JSON.stringify(r))).catch((e) => console.error("[selfcheck] crashed", e.message));
    startRefreshLoop();
  });
}

export default app;
