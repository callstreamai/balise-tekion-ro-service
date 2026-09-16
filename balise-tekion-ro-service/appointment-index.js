// Phone -> vehicle/appointment index built from Appointment Search (v3.1.0).
// Appointment Search has no phone filter, but each appointment carries customer.phones and the vehicle.
// One 7-day window (Tekion's cap), refreshed every APPT_REFRESH_MINUTES. Shared by the RO-status
// lookup (phone -> VIN -> open RO) and the scheduling fallback (phone -> upcoming appointment).

import { tekion } from "./tekion.js";

export const APPT_LOOKBACK_DAYS = Number(process.env.APPT_LOOKBACK_DAYS || 5); // + AHEAD_DAYS must stay under Tekion's 7-day cap
export const REFRESH_MS = Number(process.env.APPT_REFRESH_MINUTES || 15) * 60 * 1000;
const AHEAD_DAYS = Number(process.env.APPT_AHEAD_DAYS || 2);

let apptIndex = { builtAt: 0, byPhone: new Map(), stats: {} };
let inFlight = null;

export function normalizePhone(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : "";
}

const NISSAN_MODELS = ["Altima", "Ariya", "Armada", "Frontier", "Kicks", "Leaf", "Maxima", "Murano", "Pathfinder", "Rogue", "Rogue Sport", "Sentra", "Titan", "Titan XD", "Versa", "Z"];
export function normalizeModel(make, model) {
  if (!model) return "";
  const m = String(model).trim();
  if (/nissan/i.test(make || "")) {
    const hit = NISSAN_MODELS.find((full) => full.toLowerCase().startsWith(m.toLowerCase()) && m.length >= 3);
    if (hit) return hit;
  }
  return m;
}
export function spokenVehicle(v) {
  return [v?.year, v?.make, normalizeModel(v?.make, v?.model)].filter(Boolean).join(" ");
}

export function getIndex() { return apptIndex; }

export async function buildApptIndex(force = false) {
  if (!force && Date.now() - apptIndex.builtAt < REFRESH_MS) return apptIndex;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const now = Date.now(), DAY = 86400000;
    const byPhone = new Map();
    let pages = 0, appts = 0, error = null;
    const from = now - APPT_LOOKBACK_DAYS * DAY, to = Math.min(now + AHEAD_DAYS * DAY, from + 7 * DAY - 60000);
    try {
      let nextFetchKey = null;
      do {
        const qs = new URLSearchParams({ appointmentStartTime: String(from), appointmentEndTime: String(to) });
        if (nextFetchKey) qs.set("nextFetchKey", nextFetchKey);
        const r = await tekion.get(`/appointments?${qs}`);
        for (const a of r?.data ?? []) {
          appts++;
          const vin = a?.vehicle?.vin;
          const phones = new Set([...(a?.customer?.phones ?? []), ...(a?.deliveryContact?.phones ?? [])].map((ph) => normalizePhone(ph.number)).filter(Boolean));
          for (const ph of phones) {
            const list = byPhone.get(ph) ?? [];
            list.push({
              appointmentId: a.id, appointmentNumber: a.appointmentNumber, appointmentDateTime: a.appointmentDateTime, status: a.status,
              vin, vehicle: a.vehicle, customerId: a.customer?.id, customer: { firstName: a.customer?.firstName, lastName: a.customer?.lastName },
            });
            byPhone.set(ph, list);
          }
        }
        nextFetchKey = r?.meta?.nextFetchKey || null;
        pages++;
      } while (nextFetchKey && pages < 20);
    } catch (e) {
      error = e.body ? e.body.slice(0, 160) : e.message;
    }
    apptIndex = { builtAt: Date.now(), byPhone, stats: { pages, appointments: appts, phones: byPhone.size, lookback_days: APPT_LOOKBACK_DAYS, ahead_days: AHEAD_DAYS, error } };
    console.log("[appt-index]", JSON.stringify(apptIndex.stats));
    return apptIndex;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

// Distinct vehicles for a phone (for the RO-status VIN path).
export function vehiclesForPhone(phone10) {
  const entries = apptIndex.byPhone.get(phone10) ?? [];
  const seen = new Map();
  for (const e of entries) if (e.vin && !seen.has(e.vin)) seen.set(e.vin, e);
  return [...seen.values()];
}

export function startRefreshLoop() {
  setInterval(() => buildApptIndex(true).catch((e) => console.error("[appt-index] refresh failed", e.message)), REFRESH_MS);
}
