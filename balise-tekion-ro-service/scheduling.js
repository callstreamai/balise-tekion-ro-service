// Scheduling, rescheduling and cancellation for the Ava voice agent, on Tekion v3.1.0.
//
// Every endpoint is a Bland webhook: POST, Bearer WEBHOOK_SECRET, JSON body that always includes
// call_id. State for a call (customer, vehicle, services, offered slots, selected appointment) lives
// in an in-memory session keyed by call_id so the pathway only has to carry small spoken strings.
//
// Endpoints (mounted under /schedule):
//   identify            { phone }                      -> customer + vehicles
//   select-vehicle      { vehicle_choice }             -> one vehicle
//   new-customer        { first_name, last_name, phone, vehicle_text }
//   services            { services_text }              -> matched menu items / custom concern
//   slots               { transportation_choice, preferred_text, mileage }
//   book                { slot_choice }                -> create (or update when rescheduling)
//   find                { phone }                      -> upcoming appointments
//   select-appointment  { appointment_choice }
//   cancel              { cancel_reason }
//   answer              { question }                   -> KB answer from config (hours, location, symptoms)

import fs from "node:fs";
import path from "node:path";
import express from "express";
import { tekion, getAllPages, TekionError } from "./tekion.js";
import { makeTz, parsePreference, matchChoice } from "./timeutil.js";
import { buildApptIndex, normalizePhone, spokenVehicle, normalizeModel } from "./appointment-index.js";

export const config = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "dealer-config.json"), "utf8"));
export const tz = makeTz(config.timezone || "America/New_York");
const B = config.booking;

// ---- sessions --------------------------------------------------------------------
const SESSION_TTL_MS = 2 * 3600 * 1000;
const sessions = new Map();
export function session(callId, fallbackKey) {
  let key = String(callId ?? "").trim();
  if (!key || /^\{\{/.test(key) || key === "undefined" || key === "null") key = fallbackKey ? `k:${fallbackKey}` : "anonymous";
  let s = sessions.get(key);
  if (!s) { s = { key, createdAt: Date.now() }; sessions.set(key, s); }
  s.touchedAt = Date.now();
  return s;
}
setInterval(() => { const cut = Date.now() - SESSION_TTL_MS; for (const [k, s] of sessions) if (s.touchedAt < cut) sessions.delete(k); }, 10 * 60 * 1000).unref?.();

// ---- catalog -------------------------------------------------------------------------
export const catalog = { loadedAt: 0, shops: [], transportation: [], advisors: [], opcodes: [], customConcern: null, menu: [], error: null, detected: {} };
const CATALOG_TTL_MS = 6 * 3600 * 1000;
let catalogInFlight = null;

const lc = (s) => String(s ?? "").toLowerCase();
// Bland sends unresolved template variables literally ("{{sch_mileage}}"); treat those, and "Unknown", as absent.
const clean = (v) => { const t = String(v ?? "").trim(); return !t || /^\{\{.*\}\}$/.test(t) || /^(unknown|null|undefined|none|n\/a)$/i.test(t) ? "" : t; };
const includesAny = (hay, needles) => { const h = lc(hay); return (needles ?? []).some((n) => h.includes(lc(n))); };

export async function loadCatalog(force = false) {
  if (!force && Date.now() - catalog.loadedAt < CATALOG_TTL_MS && !catalog.error) return catalog;
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = (async () => {
    const errors = [];
    const attempt = async (label, fn) => { try { return await fn(); } catch (e) { errors.push(`${label}: ${e.message} ${e.body ?? ""}`.trim()); return null; } };
    const shops = await attempt("shops", () => getAllPages("/service-shops"));
    const transportation = await attempt("transportation", () => getAllPages("/transportation-types"));
    const advisors = await attempt("advisors", () => getAllPages("/employees?role=ServiceAdvisor&isActive=true"));
    const opcodes = await attempt("opcodes", () => getAllPages("/opcodes", { maxPages: 50 }));
    const cc = await attempt("customConcern", () => tekion.get("/opcodes?customConcern=true"));
    if (shops) catalog.shops = shops.filter((s) => !s.status || /active/i.test(s.status));
    if (transportation) catalog.transportation = transportation.filter((t) => !t.status || /active/i.test(t.status));
    if (advisors) catalog.advisors = advisors;
    if (opcodes) catalog.opcodes = opcodes;
    if (cc) catalog.customConcern = (cc.data ?? [])[0] ?? null;
    catalog.menu = resolveMenu(config.services.menu, catalog.opcodes);
    catalog.error = errors.length ? errors.join(" | ") : null;
    catalog.loadedAt = Date.now();
    console.log("[catalog]", JSON.stringify({
      shops: catalog.shops.length, transportation: catalog.transportation.map((t) => t.name), advisors: catalog.advisors.length, opcodes: catalog.opcodes.length,
      customConcern: catalog.customConcern?.opcode ?? null, menuResolved: catalog.menu.filter((m) => m.opcode).map((m) => `${m.key}=${m.opcode}`), menuUnresolved: catalog.menu.filter((m) => !m.opcode).map((m) => m.key), error: catalog.error,
    }));
    return catalog;
  })();
  try { return await catalogInFlight; } finally { catalogInFlight = null; }
}

function resolveMenu(menu, opcodes) {
  return menu.map((m) => {
    if (m.opcode) {
      const hit = opcodes.find((o) => lc(o.opcode) === lc(m.opcode));
      return { ...m, opcodeDescription: hit?.description ?? m.spoken, catalogEntry: hit ?? null };
    }
    const hit = opcodes.find((o) => includesAny(o.description, m.descriptionContains) && (!o.defaultPayType || o.defaultPayType === "CUSTOMER_PAY"))
    ?? opcodes.find((o) => includesAny(o.description, m.descriptionContains));
    return { ...m, opcode: hit?.opcode ?? null, opcodeDescription: hit?.description ?? m.spoken, catalogEntry: hit ?? null };
  });
}

function pickShop() {
  const allowed = B.allowedShopIds?.length ? catalog.shops.filter((s) => B.allowedShopIds.includes(s.id)) : catalog.shops;
  return allowed.find((s) => s.isDefault) ?? allowed[0] ?? null;
}
function advisorIdFor(emp, field) { return emp?.[field] ?? null; }
function pickAdvisor() {
  if (B.defaultServiceAdvisorId) return { id: B.defaultServiceAdvisorId, source: "config" };
  const allowed = B.allowedServiceAdvisorIds?.length
  ? catalog.advisors.filter((a) => [a.employeeDisplayNumber, a.employeeId, a.id].some((v) => B.allowedServiceAdvisorIds.includes(v)))
    : catalog.advisors;
  const emp = allowed[0];
  if (!emp) return null;
  const field = catalog.detected.advisorField ?? (B.serviceAdvisorIdField !== "auto" ? B.serviceAdvisorIdField : "employeeDisplayNumber");
  return { id: advisorIdFor(emp, field), source: field, name: emp.displayName ?? `${emp.fname ?? ""} ${emp.lname ?? ""}`.trim() };
}
function transportationByKey(key) {
  const opt = config.transportation.options.find((o) => o.key === key) ?? config.transportation.options.find((o) => o.default);
  const cat = catalog.transportation.find((t) => includesAny(t.name, opt.catalogNames));
  return { opt, cat };
}
function matchTransportation(text) {
  const t = lc(text);
  const opts = config.transportation.options;
  const hit = opts.find((o) => includesAny(t, o.callerPhrases));
  return hit ?? opts.find((o) => o.default);
}

// ---- slot search with self-detection of the two ambiguous fields -------------------------
async function callSlots(base, opcodes) {
  const field = catalog.detected.slotOpcodeField ?? (B.slotOpcodeField !== "auto" ? B.slotOpcodeField : null);
  const tryField = async (f) => tekion.post("/appointment-slots", opcodes?.length ? { ...base, [f]: opcodes } : base);
  if (field || !opcodes?.length) return tryField(field ?? "opcode");
  try { const r = await tryField("opcode"); catalog.detected.slotOpcodeField = "opcode"; return r; }
  catch (e) { if (e.status !== 400) throw e; const r = await tryField("opcodes"); catalog.detected.slotOpcodeField = "opcodes"; console.log("[detect] slot opcode field = opcodes"); return r; }
}

async function detectAdvisorField(shop, transportId, startDate, endDate) {
  if (catalog.detected.advisorField || B.serviceAdvisorIdField !== "auto" || B.defaultServiceAdvisorId) return;
  const emp = catalog.advisors[0];
  if (!emp) return;
  for (const f of ["employeeDisplayNumber", "employeeId", "id"]) {
    const id = advisorIdFor(emp, f);
    if (!id) continue;
    try {
      const r = await tekion.post("/appointment-slots", { shopId: shop.id, transportationId: transportId, serviceAdvisorId: id, startDate, endDate });
      if (Array.isArray(r?.data)) { catalog.detected.advisorField = f; console.log(`[detect] serviceAdvisorId field = ${f}`); return; }
    } catch (e) { if (![400, 404].includes(e.status)) throw e; }
  }
  console.warn("[detect] no advisor id field accepted by Slots; falling back to employeeDisplayNumber");
  catalog.detected.advisorField = "employeeDisplayNumber";
}

function withinHours(epochMs) {
  const p = tz.parts(epochMs);
  const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][p.wd];
  const h = config.hours?.service?.[day];
  if (!h) return false;
  const [o, c] = h.map((x) => { const [hh, mm] = x.split(":").map(Number); return hh * 60 + mm; });
  const m = p.h * 60 + p.mi;
  return m >= o && m < c;
}

function earliestAllowed(now = Date.now()) {
  let t = now + (B.minimumLeadTimeMinutes ?? 0) * 60000;
  if (B.allowSameDay === false) t = Math.max(t, tz.addDays(tz.startOfDay(now), 1));
  return t;
}

async function findSlots(s, pref, now = Date.now()) {
  await loadCatalog();
  const shop = s.existingAppointment ? (catalog.shops.find((x) => x.id === s.existingAppointment.shopId) ?? pickShop()) : pickShop();
  if (!shop) throw Object.assign(new Error("no shop"), { reason: "catalog_unavailable" });
  let transportId, advisorId;
  if (s.existingAppointment && !s.transportation) { transportId = s.existingAppointment.transportationTypeId; advisorId = s.existingAppointment.serviceAdvisorId; }
  else {
    const { cat } = transportationByKey(s.transportation?.key);
    transportId = cat?.id ?? catalog.transportation[0]?.id;
    if (!transportId) throw Object.assign(new Error("no transportation"), { reason: "catalog_unavailable" });
    advisorId = s.existingAppointment?.serviceAdvisorId;
  }
  const floor = earliestAllowed(now);
  const horizonEnd = tz.addDays(tz.startOfDay(now), B.horizonDays ?? 30);
  let winStart = pref.dayEpoch ?? pref.rangeStart ?? tz.startOfDay(floor);
  let winEnd = pref.dayEpoch ?? pref.rangeEnd ?? tz.addDays(winStart, (B.defaultSearchDays ?? 7) - 1);
  if (winStart < tz.startOfDay(floor)) winStart = tz.startOfDay(floor);
  if (winEnd < winStart) winEnd = winStart;
  if (winEnd > horizonEnd) winEnd = horizonEnd;
  const requestedDay = pref.dayEpoch ? tz.ymd(pref.dayEpoch) : null;
  // A single requested day: widen the fetch so we can offer alternates when it is full.
const fetchEnd = requestedDay ? Math.min(tz.addDays(winEnd, 6), horizonEnd) : winEnd;
  const startDate = tz.ymd(winStart), endDate = tz.ymd(fetchEnd);

if (!advisorId) {
  await detectAdvisorField(shop, transportId, startDate, tz.ymd(Math.min(tz.addDays(winStart, 2), horizonEnd)));
  const adv = pickAdvisor();
  if (!adv?.id) throw Object.assign(new Error("no advisor"), { reason: "catalog_unavailable" });
  advisorId = adv.id;
}
  const opcodes = (s.services ?? []).map((x) => x.opcode).filter(Boolean);
  const body = { shopId: shop.id, transportationId: transportId, serviceAdvisorId: advisorId, startDate, endDate };
  if (s.vehicle?.year && s.vehicle?.make && s.vehicle?.model) body.vehicleInfo = { year: Number(s.vehicle.year) || undefined, make: s.vehicle.make, model: s.vehicle.model };
  const r = await callSlots(body, opcodes);

const all = [];
  for (const day of r?.data ?? []) {
    if (day.isClosed) continue;
    for (const sl of day.slots ?? []) {
      if (!sl.isAvailable) continue;
      if (sl.startTime < floor || sl.startTime > horizonEnd) continue;
      if (!withinHours(sl.startTime)) continue;
      all.push({ startTime: sl.startTime, endTime: sl.endTime });
    }
  }
  all.sort((a, b) => a.startTime - b.startTime);
  const inWindow = all.filter((x) => x.startTime >= winStart && x.startTime < tz.addDays(winEnd, 1));
  const byTod = (list) => {
    if (pref.hour !== null) { const near = list.filter((x) => Math.abs(tz.minutesOfDay(x.startTime) / 60 - pref.hour) <= 1.01); if (near.length) return near; }
    if (pref.timeOfDay === "morning") { const m = list.filter((x) => tz.minutesOfDay(x.startTime) < 12 * 60); if (m.length) return m; }
    if (pref.timeOfDay === "afternoon") { const m = list.filter((x) => tz.minutesOfDay(x.startTime) >= 12 * 60); if (m.length) return m; }
    if (pref.timeOfDay === "midday") { const m = list.filter((x) => { const mm = tz.minutesOfDay(x.startTime); return mm >= 11 * 60 && mm < 14 * 60; }); if (m.length) return m; }
    return list;
  };
  let pool = byTod(inWindow);
  const requestedDayUnavailable = Boolean(requestedDay) && !pool.some((x) => tz.ymd(x.startTime) === requestedDay);
  if (!pool.length && requestedDay) pool = byTod(all.filter((x) => x.startTime >= winStart));
  // Spread the offers: distinct days when possible, otherwise distinct times at least 90 minutes apart.
const offers = [];
  const n = B.offerCount ?? 3;
  const days = [...new Set(pool.map((x) => tz.ymd(x.startTime)))];
  if (requestedDay && !requestedDayUnavailable) {
    for (const x of pool) { if (offers.length >= n) break; if (!offers.length || x.startTime - offers[offers.length - 1].startTime >= 90 * 60000) offers.push(x); }
  } else {
    for (const d of days) { if (offers.length >= n) break; offers.push(pool.find((x) => tz.ymd(x.startTime) === d)); }
    for (const x of pool) { if (offers.length >= n) break; if (!offers.includes(x) && offers.every((o) => Math.abs(o.startTime - x.startTime) >= 90 * 60000)) offers.push(x); }
  }
  offers.sort((a, b) => a.startTime - b.startTime);
  return { offers, requestedDayUnavailable, requestedDay, totalAvailable: all.length, meta: { shopId: shop.id, transportId, advisorId, startDate, endDate, opcodes, slotOpcodeField: catalog.detected.slotOpcodeField ?? B.slotOpcodeField, advisorField: catalog.detected.advisorField ?? B.serviceAdvisorIdField } };
}

// ---- customers -------------------------------------------------------------------------
const VERSION = config.customerApiVersion || "v3.1.0";
async function searchCustomersByPhone(phone10) {
  const variants = [phone10, `1${phone10}`, `+1${phone10}`];
  for (const v of variants) {
    const r = await tekion.get(`/customers?phone=${encodeURIComponent(v)}`, VERSION);
    const data = (r?.data ?? []).filter((c) => !c.status || /active/i.test(c.status));
    if (data.length) return data;
  }
  return [];
}
function customerVehicles(c) {
  const list = VERSION.startsWith("v4") ? (c.vehicles ?? []) : (c.vehicleInfo ?? []);
  return list.map((v) => ({ id: v.vehicleId ?? v.id ?? null, vin: v.vin ?? null, year: v.year ? String(v.year) : null, make: v.make ?? null, model: v.model ?? null, spoken: spokenVehicle(v) }))
  .filter((v) => v.vin || v.id || (v.make && v.model));
}
function customerName(c) {
  if (VERSION.startsWith("v4")) return { firstName: c.customerDetails?.name?.firstName ?? c.firstName, lastName: c.customerDetails?.name?.lastName ?? c.lastName };
  return { firstName: c.firstName ?? "", lastName: c.lastName ?? "" };
}
function listSpoken(items) {
  if (items.length <= 1) return items[0] ?? "";
  return items.slice(0, -1).join(", ") + ", or " + items[items.length - 1];
}
function matchVehicle(text, vehicles) {
  const t = lc(text);
  if (vehicles.length === 1 && /\b(yes|yeah|yep|correct|that's it|that one|right|sure)\b/.test(t)) return 0;
  const ord = matchChoice(t, vehicles.map(() => ({ startTime: 0 })), tz);
  if (ord !== null && /\b(first|second|third|1st|2nd|3rd|last)\b/.test(t)) return ord;
  const scored = vehicles.map((v, i) => {
    let s = 0;
    if (v.year && t.includes(String(v.year))) s += 2;
    if (v.year && t.includes(String(v.year).slice(-2)) && !t.includes(String(v.year))) s += 1;
    const model = lc(normalizeModel(v.make, v.model));
    if (model && (t.includes(model) || model.split(" ").some((w) => w.length > 3 && t.includes(w)))) s += 2;
    if (v.make && t.includes(lc(v.make))) s += 0.5;
    return { i, s };
  }).sort((a, b) => b.s - a.s);
  if (scored[0]?.s >= 2 && (scored.length === 1 || scored[0].s > scored[1].s)) return scored[0].i;
  return null;
}

// ---- services --------------------------------------------------------------------------
function matchServices(text) {
  const t = ` ${lc(text).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
  const hits = [];
  for (const m of catalog.menu) if (m.callerPhrases.some((p) => t.includes(` ${lc(p)} `) || (p.length > 5 && t.includes(lc(p))))) hits.push(m);
  // symptom guide suggestions ("pulling to the right" -> alignment)
for (const e of config.symptomGuide?.entries ?? []) {
  if (e.suggestService && e.phrases.some((p) => t.includes(lc(p)))) { const m = catalog.menu.find((x) => x.key === e.suggestService); if (m && !hits.includes(m)) hits.push(m); }
}
  return [...new Set(hits)];
}

function buildJobs(s) {
  const jobs = [];
  for (const svc of s.services ?? []) {
    if (svc.custom) {
      jobs.push({ type: "DEFAULT", payType: "CUSTOMER_PAY", concern: svc.concern, operations: [{ opcode: svc.opcode, opcodeDescription: svc.opcodeDescription, payType: "CUSTOMER_PAY" }] });
    } else {
      const op = { opcode: svc.opcode, opcodeDescription: svc.opcodeDescription, payType: svc.catalogEntry?.defaultPayType ?? "CUSTOMER_PAY" };
      const flat = svc.catalogEntry?.priceDetails?.find((p) => p.payType === "CUSTOMER_PAY")?.flatPrice;
      if (flat?.amount != null) op.laborAmount = { amount: Number(flat.amount), currency: flat.currency ?? "USD" };
      jobs.push({ type: svc.type ?? "DEFAULT", payType: op.payType, concern: svc.concern ?? svc.spoken, operations: [op] });
    }
  }
  return jobs;
}
function totalAmount(jobs) {
  let sum = 0;
  for (const j of jobs) for (const o of j.operations) sum += Number(o.laborAmount?.amount ?? 0) + Number(o.maxPartsSaleAmount?.amount ?? 0);
  return { amount: Math.round(sum * 100) / 100, currency: "USD" };
}
function customerPayload(c, phone10) {
  if (c.isNew) return { customerType: "INDIVIDUAL", firstName: c.firstName, lastName: c.lastName, companyName: "", phones: [{ phoneType: "MOBILE", number: phone10, isPrimary: true }], preferredContactType: "CALL", email: "" };
  const addr = (c.addresses ?? []).find((a) => a.isCurrent) ?? (c.addresses ?? [])[0];
  const out = {
    id: c.id, arcId: c.arcId, customerType: c.customerType ?? "INDIVIDUAL", firstName: c.firstName ?? "", lastName: c.lastName ?? "", companyName: c.companyName ?? "",
    phones: (c.phones ?? []).map((p) => ({ phoneType: p.phoneType ?? "MOBILE", number: p.number, isPrimary: Boolean(p.isPrimary) })),
    preferredContactType: c.preferredContactType ?? "CALL", email: c.email ?? "",
  };
  if (c.preferredCommunicationMode) out.preferredCommunicationMode = c.preferredCommunicationMode;
  if (addr?.line1) out.address = { line1: addr.line1, line2: addr.line2 ?? "", zipCode: addr.zip ?? addr.zipCode ?? "", state: addr.state ?? "", country: addr.country ?? "US", city: addr.city ?? "", county: addr.county ?? "" };
  if (!out.phones.length && phone10) out.phones = [{ phoneType: "MOBILE", number: phone10, isPrimary: true }];
  return out;
}
function vehiclePayload(v) {
  const out = { year: String(v.year ?? ""), make: v.make ?? "", model: v.model ?? "" };
  if (v.id) out.id = v.id;
  if (v.vin) out.vin = v.vin;
  return out;
}
function comments(s) {
  const bits = ["Booked by Ava, the phone assistant."];
  if (B.mileageInComments && s.mileage) bits.push(`Customer-reported mileage: ${s.mileage}.`);
  if (s.concernText) bits.push(`Caller said: ${s.concernText}`);
  if (s.transportation?.opt?.requiresAdvisor) bits.push(`Requested ${s.transportation.opt.spoken}; please confirm availability.`);
  return bits.join(" ");
}
function apptSpoken(a) {
  const when = a.appointmentDateTime ? tz.spokenDateTime(Number(a.appointmentDateTime)) : "";
  const veh = spokenVehicle(a.vehicle);
  return veh ? `${when} for your ${veh}` : when;
}
function servicesSpoken(list) { return listSpoken((list ?? []).map((x) => x.spoken)); }

// ---- knowledge answers (hours, location, symptoms) ------------------------------------------
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
function spokenClock(hhmm) { const [h, m] = hhmm.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; const hh = ((h + 11) % 12) + 1; return m ? `${hh}:${String(m).padStart(2, "0")} ${ap}` : `${hh} ${ap}`; }
export function hoursSpoken(dept = "service") {
  const h = config.hours?.[dept];
  if (!h) return "";
  const groups = [];
  for (const d of DAYS) {
    const v = h[d] ? `${spokenClock(h[d][0])} to ${spokenClock(h[d][1])}` : "closed";
    const g = groups[groups.length - 1];
    if (g && g.v === v) g.days.push(d); else groups.push({ v, days: [d] });
  }
  return groups.map((g) => `${g.days.length > 1 ? `${DAY_NAMES[g.days[0]]} through ${DAY_NAMES[g.days[g.days.length - 1]]}` : DAY_NAMES[g.days[0]]} ${g.v}`).join(", ");
}
export function answerQuestion(question) {
  const q = lc(question);
  if (/\bhour|\bopen\b|\bclose|what time|until when|are you open/.test(q)) {
    const dept = /\bsales\b/.test(q) ? "sales" : /\bparts\b/.test(q) ? "parts" : "service";
    return { topic: "hours", spoken: `The ${dept} department is open ${hoursSpoken(dept)}.` };
  }
  if (/where|located|location|address|directions|how do i get|find you/.test(q)) return { topic: "location", spoken: `We are at ${config.address}. If you are using GPS, search for ${config.dealerName}.` };
  if (/phone number|call (the )?(service|parts|sales)|number for/.test(q)) return { topic: "phone", spoken: `The service department's direct number is ${config.phones.service.split("-").join(" ")}.` };
  if (/wifi|wait(ing)? (room|area)|coffee|amenit|while i wait|shuttle|loaner|rental|express/.test(q)) return { topic: "amenities", spoken: `While you wait we have ${listSpoken(config.amenities).replace(", or ", ", and ")}. Shuttle and loaner availability depends on the day, and the service advisor confirms it when you book.` };
  if (/cancel(lation)? (policy|fee)|fee for|charge for cancel|late fee/.test(q)) return { topic: "policy", spoken: config.policies.cancellationPolicy };
  for (const e of config.symptomGuide?.entries ?? []) if (e.phrases.some((p) => q.includes(lc(p)))) return { topic: "symptom", spoken: e.spoken, suggestService: e.suggestService };
  return { topic: "unknown", spoken: "" };
}

// ---- HTTP -------------------------------------------------------------------------------
export function schedulingRouter(auth) {
  const r = express.Router();
  r.use(auth);

const fail = (res, base, reason, extra = {}) => res.json({ ...base, ok: false, reason, ...extra });
  const wrap = (fn) => async (req, res) => {
    const b = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, typeof v === "string" ? clean(v) : v]));
    const phone = normalizePhone(b.phone) || normalizePhone(b.from);
    const s = session(b.call_id, phone);
    const base = { dealer: config.dealerName };
    try { await fn(s, b, res, base, phone); }
    catch (e) {
      const reason = e.reason ?? (e instanceof TekionError ? `tekion_${e.status}` : "lookup_failed");
      console.error(`[schedule${req.path}]`, e.message, e.body ?? "");
      fail(res, base, reason, { spoken_error: "I'm having trouble reaching the scheduling system right now." });
    }
  };

r.post("/identify", wrap(async (s, b, res, base, phone) => {
  if (!phone) return fail(res, base, "missing_phone", { found: false, match_count: 0 });
  const customers = await searchCustomersByPhone(phone);
  s.phone = phone;
  if (!customers.length) {
    // Fallback: a recent appointment on this phone gives us the customer id and vehicle.
  const idx = await buildApptIndex();
    const entries = idx.byPhone.get(phone) ?? [];
    const withId = entries.find((e) => e.customerId);
    if (withId) {
      const rr = await tekion.get(`/customers?id=${encodeURIComponent(withId.customerId)}`, VERSION);
      const c = (rr?.data ?? [])[0];
      if (c) customers.push(c);
    }
  }
  if (!customers.length) { s.customer = null; s.vehicles = []; return res.json({ ...base, ok: true, found: false, match_count: 0, reason: "no_customer" }); }
  // Several customer records on one phone (household): merge their vehicles and prefer the first record for identity.
                         const c = customers[0];
  const vehicles = [];
  for (const cc of customers) for (const v of customerVehicles(cc)) if (!vehicles.some((x) => (x.vin && x.vin === v.vin) || (x.id && x.id === v.id))) vehicles.push({ ...v, customerRef: cc });
  s.customer = c; s.customers = customers; s.vehicles = vehicles; s.vehicle = vehicles.length === 1 ? vehicles[0] : null;
  if (s.vehicle) s.customer = s.vehicle.customerRef;
  const name = customerName(c);
  return res.json({
    ...base, ok: true, found: true, match_count: customers.length, customer_id: c.id, first_name: name.firstName ?? "",
    vehicle_count: vehicles.length, vehicle_spoken: vehicles.length === 1 ? vehicles[0].spoken : "", vehicles_spoken: listSpoken(vehicles.map((v) => `the ${v.spoken}`)),
  });
}));

r.post("/select-vehicle", wrap(async (s, b, res, base) => {
  const vehicles = s.vehicles ?? [];
  if (!vehicles.length) return fail(res, base, "no_vehicles", { matched: false });
  const i = matchVehicle(b.vehicle_choice, vehicles);
  if (i === null) return res.json({ ...base, ok: true, matched: false, reason: "unclear", vehicles_spoken: listSpoken(vehicles.map((v) => `the ${v.spoken}`)) });
  s.vehicle = vehicles[i]; if (s.vehicle.customerRef) s.customer = s.vehicle.customerRef;
  return res.json({ ...base, ok: true, matched: true, vehicle_spoken: s.vehicle.spoken, vin: s.vehicle.vin ?? "" });
}));

r.post("/new-customer", wrap(async (s, b, res, base, phone) => {
  const first = String(b.first_name ?? "").trim(), last = String(b.last_name ?? "").trim();
  const vt = String(b.vehicle_text ?? "").trim();
  const ym = vt.match(/\b(19|20)\d{2}\b/);
  const year = ym ? ym[0] : null;
  let rest = vt.replace(year ?? "", "").replace(/\b(a|an|the|my|its|it's|is)\b/gi, " ").replace(/\s+/g, " ").trim();
  let make = "Nissan", model = rest;
  const mk = rest.match(/^(nissan|toyota|honda|ford|chevrolet|chevy|hyundai|kia|subaru|jeep|infiniti|mazda|volkswagen|vw|bmw|mercedes|audi|lexus|acura|gmc|ram|dodge|tesla)\b\s*/i);
  if (mk) { make = mk[1]; model = rest.slice(mk[0].length).trim(); }
  if (/^chevy$/i.test(make)) make = "Chevrolet"; if (/^vw$/i.test(make)) make = "Volkswagen";
  make = make.charAt(0).toUpperCase() + make.slice(1).toLowerCase();
  model = normalizeModel(make, model) || model;
  const haveCustomer = Boolean(s.customer && !s.customer.isNew);
  const missing = [!haveCustomer && !first && "first_name", !haveCustomer && !last && "last_name", !year && "year", !model && "model"].filter(Boolean);
  if (missing.length) return res.json({ ...base, ok: true, registered: false, reason: "incomplete", missing: missing.join(",") });
  if (!s.phone && phone) s.phone = phone;
  if (haveCustomer) {
    // Existing customer, different vehicle: keep the customer, add the vehicle without an id.
  s.vehicle = { id: null, vin: null, year, make, model, spoken: spokenVehicle({ year, make, model }) };
  } else {
    s.customer = { isNew: true, firstName: first, lastName: last };
    s.vehicle = { id: null, vin: null, year, make, model, spoken: spokenVehicle({ year, make, model }) };
  }
  s.vehicles = [s.vehicle];
  return res.json({ ...base, ok: true, registered: true, vehicle_spoken: s.vehicle.spoken, first_name: s.customer.firstName ?? first });
}));

r.post("/services", wrap(async (s, b, res, base) => {
  await loadCatalog();
  const text = String(b.services_text ?? "").trim();
  if (!text) return fail(res, base, "missing_services", { bookable: false });
  s.concernText = text;
  const hits = matchServices(text).map((m) => ({ ...m, concern: text }));
  const seenOp = new Set();
  const services = hits.filter((m) => m.opcode && !seenOp.has(m.opcode) && seenOp.add(m.opcode));
  const unresolved = hits.filter((m) => !m.opcode);
  let usedCustom = false;
  if (!services.length) {
    if (config.services.allowCustomConcern && catalog.customConcern?.opcode) {
      services.push({ key: "custom", custom: true, spoken: "the concern you described", opcode: catalog.customConcern.opcode, opcodeDescription: catalog.customConcern.description ?? "Customer concern", concern: text, requiresAdvisor: config.services.customConcernRequiresAdvisor, type: "DEFAULT" });
      usedCustom = true;
    } else return res.json({ ...base, ok: true, bookable: false, reason: unresolved.length ? "menu_unresolved" : "no_match", services_spoken: servicesSpoken(unresolved) });
  }
  s.services = services;
  const requiresAdvisor = services.some((x) => x.requiresAdvisor) || unresolved.some((x) => x.requiresAdvisor);
  const symptom = (config.symptomGuide?.entries ?? []).find((e) => e.phrases.some((p) => lc(text).includes(lc(p))));
  return res.json({
    ...base, ok: true, bookable: !requiresAdvisor, requires_advisor: requiresAdvisor, used_custom_concern: usedCustom,
    services_spoken: usedCustom ? "an inspection for the concern you described" : servicesSpoken(services),
    symptom_spoken: symptom?.spoken ?? "", service_count: services.length,
  });
}));

r.post("/slots", wrap(async (s, b, res, base) => {
  if (!s.vehicle && !s.existingAppointment) return fail(res, base, "no_vehicle", { found: false, options_count: 0 });
  if (!s.services?.length && !s.existingAppointment) return fail(res, base, "no_services", { found: false, options_count: 0 });
  if (b.mileage) { const m = String(b.mileage).replace(/\D/g, ""); if (m) s.mileage = m; }
  if (b.transportation_choice) {
    const opt = matchTransportation(b.transportation_choice);
    const { cat } = transportationByKey(opt.key);
    s.transportation = { key: opt.key, opt, cat };
  } else if (!s.transportation && !s.existingAppointment) { const opt = config.transportation.options.find((o) => o.default); s.transportation = { key: opt.key, opt, cat: transportationByKey(opt.key).cat }; }
  const pref = parsePreference(b.preferred_text, tz);
  const result = await findSlots(s, pref);
  s.offers = result.offers; s.slotMeta = result.meta; s.preference = pref.raw;
  const spokenOffers = result.offers.map((o) => tz.spokenDateTime(o.startTime));
  return res.json({
    ...base, ok: true, found: result.offers.length > 0, options_count: result.offers.length,
    options_spoken: listSpoken(spokenOffers), first_option_spoken: spokenOffers[0] ?? "",
    requested_day_unavailable: result.requestedDayUnavailable, requested_day_spoken: result.requestedDay ? tz.spokenDay(pref.dayEpoch) : "",
    transportation_spoken: s.transportation?.opt?.spoken ?? "", transportation_needs_advisor: Boolean(s.transportation?.opt?.requiresAdvisor),
    mode: s.existingAppointment ? "reschedule" : "new", reason: result.offers.length ? "" : (result.totalAvailable ? "none_in_window" : "no_availability"),
  });
}));

r.post("/book", wrap(async (s, b, res, base) => {
  if (!s.offers?.length) return fail(res, base, "no_offers", { booked: false });
  const i = matchChoice(b.slot_choice, s.offers, tz);
  if (i === null) return res.json({ ...base, ok: true, booked: false, reason: "unclear", options_spoken: listSpoken(s.offers.map((o) => tz.spokenDateTime(o.startTime))) });
  const slot = s.offers[i];
  if (s.booked && s.booked.startTime === slot.startTime) return res.json({ ...base, ok: true, booked: true, ...s.booked.response, duplicate: true });
  const when = slot.startTime;
  let response;
  if (s.existingAppointment) {
    const a = s.existingAppointment;
    const payload = {
      id: a.id, shopId: a.shopId, transportationTypeId: s.transportation?.cat?.id ?? a.transportationTypeId, serviceAdvisorId: a.serviceAdvisorId,
      appointmentDateTime: B.updateTimestampFormat === "iso" ? new Date(when).toISOString() : when,
      customer: customerPayload(a.customer ?? s.customer ?? {}, s.phone), vehicle: { ...vehiclePayload(a.vehicle ?? {}), ...(a.vehicle?.mileage ? { mileage: a.vehicle.mileage } : {}) },
      deliveryContactSameAsCustomer: a.deliveryContactSameAsCustomer ?? true,
      notifyCustomer: B.notifyCustomerOnUpdate !== false, customerComments: [a.customerComments, `Moved by Ava, the phone assistant, from ${tz.spokenDateTime(Number(a.appointmentDateTime))}.`].filter(Boolean).join(" "),
      postTaxTotalAmount: a.postTaxTotalAmount ?? { amount: 0, currency: "USD" },
    };
    if (a.deliveryContactSameAsCustomer === false && a.deliveryContact) payload.deliveryContact = a.deliveryContact;
    const existingJobs = (a.jobs ?? []).map((j) => ({ id: j.id, type: j.type ?? "DEFAULT", payType: j.payType, concern: j.concern, operations: (j.operations ?? []).map((o) => ({ id: o.id, opcode: o.opcode, opcodeDescription: o.opcodeDescription, payType: o.payType, ...(o.laborAmount ? { laborAmount: o.laborAmount } : {}) })) }));
    if (B.rescheduleJobsMode === "jobs") { payload.jobs = existingJobs.map(({ id, ...j }) => ({ ...j, operations: j.operations.map(({ id: _i, ...o }) => o) })); }
    else { payload.jobs = []; payload.updatedJobs = existingJobs; payload.deletedJobs = []; }
    const r = await tekion.put("/appointments", payload);
    const d = r?.data ?? r;
    response = { mode: "reschedule", appointment_id: d.id ?? a.id, appointment_number: d.appointmentNumber ?? d.number ?? a.appointmentNumber ?? "", appointment_spoken: tz.spokenDateTime(when), vehicle_spoken: spokenVehicle(a.vehicle), previous_spoken: tz.spokenDateTime(Number(a.appointmentDateTime)) };
    s.existingAppointment = { ...a, appointmentDateTime: when };
  } else {
    if (!s.customer || !s.vehicle) return fail(res, base, "no_customer", { booked: false });
    const jobs = buildJobs(s);
    const payload = {
      shopId: s.slotMeta.shopId, transportationTypeId: s.slotMeta.transportId, serviceAdvisorId: s.slotMeta.advisorId, appointmentDateTime: when,
      customer: customerPayload(s.customer, s.phone), vehicle: vehiclePayload(s.vehicle), deliveryContactSameAsCustomer: true,
      jobs, notifyCustomer: B.notifyCustomerOnCreate !== false, customerComments: comments(s), postTaxTotalAmount: totalAmount(jobs),
    };
    const r = await tekion.post("/appointments", payload);
    const d = r?.data ?? r;
    response = { mode: "new", appointment_id: d.id ?? "", appointment_number: d.number ?? d.appointmentNumber ?? "", appointment_spoken: tz.spokenDateTime(when), vehicle_spoken: s.vehicle.spoken, services_spoken: servicesSpoken(s.services), transportation_spoken: s.transportation?.opt?.spoken ?? "" };
  }
  s.booked = { startTime: when, response };
  console.log("[book]", JSON.stringify({ mode: response.mode, appointment_id: response.appointment_id, when: tz.spokenDateTime(when) }));
  return res.json({ ...base, ok: true, booked: true, ...response, arrival_spoken: config.policies.arrivalInstructions });
}));

r.post("/find", wrap(async (s, b, res, base, phone) => {
  if (!phone && !s.customer) return fail(res, base, "missing_phone", { found: false, match_count: 0 });
  const now = Date.now();
  const start = now - 2 * 3600 * 1000, end = tz.addDays(now, B.horizonDays ?? 30) + 86400000;
  let customers = s.customers ?? [];
  if (!customers.length && phone) { customers = await searchCustomersByPhone(phone); s.phone = phone; }
  let appts = [];
  for (const c of customers) {
    const qs = new URLSearchParams({ customerId: c.id, appointmentStartTime: String(start), appointmentEndTime: String(end) });
    const r = await tekion.get(`/appointments?${qs}`);
    appts.push(...(r?.data ?? []));
  }
  if (!appts.length && phone) {
    const idx = await buildApptIndex();
    const ids = [...new Set((idx.byPhone.get(phone) ?? []).filter((e) => Number(e.appointmentDateTime) >= start && e.appointmentId).map((e) => e.appointmentId))];
    for (const id of ids) { const r = await tekion.get(`/appointments?id=${encodeURIComponent(id)}`); appts.push(...(r?.data ?? [])); }
  }
  appts = appts.filter((a) => a.appointmentDateTime >= start && !/cancel|complete|closed|void|no.?show/i.test(a.status ?? ""));
  const seen = new Set(); appts = appts.filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
  appts.sort((a, b2) => a.appointmentDateTime - b2.appointmentDateTime);
  s.appointments = appts; s.customers = customers; if (!s.customer && customers[0]) s.customer = customers[0];
  if (!appts.length) return res.json({ ...base, ok: true, found: false, match_count: 0, reason: customers.length ? "no_appointments" : "no_customer" });
  if (appts.length === 1) { s.existingAppointment = appts[0]; s.vehicle = { ...vehiclePayload(appts[0].vehicle ?? {}), spoken: spokenVehicle(appts[0].vehicle) }; }
  return res.json({
    ...base, ok: true, found: appts.length === 1, match_count: appts.length,
    appointment_spoken: appts.length === 1 ? apptSpoken(appts[0]) : "", services_spoken: appts.length === 1 ? listSpoken((appts[0].jobs ?? []).flatMap((j) => j.operations ?? []).map((o) => o.opcodeDescription).filter(Boolean)) : "",
    options_spoken: listSpoken(appts.slice(0, 3).map(apptSpoken)),
  });
}));

r.post("/select-appointment", wrap(async (s, b, res, base) => {
  const appts = s.appointments ?? [];
  if (!appts.length) return fail(res, base, "no_appointments", { matched: false });
  const t = lc(b.appointment_choice);
  let i = matchChoice(t, appts.map((a) => ({ startTime: Number(a.appointmentDateTime) })), tz);
  if (i === null) { const byVeh = matchVehicle(t, appts.map((a) => ({ year: a.vehicle?.year, make: a.vehicle?.make, model: a.vehicle?.model }))); if (byVeh !== null) i = byVeh; }
  if (i === null) return res.json({ ...base, ok: true, matched: false, reason: "unclear", options_spoken: listSpoken(appts.slice(0, 3).map(apptSpoken)) });
  s.existingAppointment = appts[i]; s.vehicle = { ...vehiclePayload(appts[i].vehicle ?? {}), spoken: spokenVehicle(appts[i].vehicle) };
  return res.json({ ...base, ok: true, matched: true, appointment_spoken: apptSpoken(appts[i]), vehicle_spoken: s.vehicle.spoken });
}));

r.post("/cancel", wrap(async (s, b, res, base) => {
  const a = s.existingAppointment;
  if (!a) return fail(res, base, "no_appointment", { cancelled: false });
  if (s.cancelled?.id === a.id) return res.json({ ...base, ok: true, cancelled: true, duplicate: true, appointment_spoken: apptSpoken(a) });
  const reason = String(b.cancel_reason ?? "").trim() || "Customer requested cancellation by phone";
  await tekion.post("/appointments/cancel", { id: a.id, cancelReason: reason.slice(0, 200), donotNotifyCustomer: Boolean(B.cancelNotifyFlagValue) });
  s.cancelled = { id: a.id, at: Date.now() };
  console.log("[cancel]", JSON.stringify({ appointment_id: a.id }));
  // Keep the vehicle/customer so the caller can rebook in the same call.
                       s.existingAppointment = null; s.offers = null; s.booked = null;
  return res.json({ ...base, ok: true, cancelled: true, appointment_spoken: apptSpoken(a), vehicle_spoken: spokenVehicle(a.vehicle) });
}));

r.post("/answer", wrap(async (_s, b, res, base) => res.json({ ...base, ok: true, ...answerQuestion(b.question) })));

r.get("/catalog", async (_req, res) => {
  await loadCatalog();
  res.json({
    loadedAt: catalog.loadedAt, error: catalog.error, detected: catalog.detected,
    shops: catalog.shops, transportation: catalog.transportation,
    advisors: catalog.advisors.map((a) => ({ id: a.id, employeeId: a.employeeId, employeeDisplayNumber: a.employeeDisplayNumber, displayName: a.displayName })),
    customConcern: catalog.customConcern, menu: catalog.menu.map((m) => ({ key: m.key, spoken: m.spoken, opcode: m.opcode, opcodeDescription: m.opcodeDescription, requiresAdvisor: m.requiresAdvisor })),
    opcodeCount: catalog.opcodes.length, opcodeSample: catalog.opcodes.slice(0, 40).map((o) => `${o.opcode}: ${o.description}`),
  });
});

return r;
}
