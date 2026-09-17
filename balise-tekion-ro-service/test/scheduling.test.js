import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeMock } from "./mock-tekion.js";

let mock, mockServer, app, appServer, base, state;
const SECRET = "test-webhook-secret";

before(async () => {
  mock = makeMock(); state = mock.state;
  mockServer = await new Promise((r) => { const s = mock.app.listen(0, () => r(s)); });
  process.env.NODE_ENV = "test";
  process.env.TEKION_BASE = `http://127.0.0.1:${mockServer.address().port}/openapi`;
  process.env.TEKION_APP_ID = "app"; process.env.TEKION_SECRET_KEY = "secret"; process.env.TEKION_DEALER_ID = "baliseautogroup_7772_0"; process.env.WEBHOOK_SECRET = SECRET;
  ({ default: app } = await import("../server.js"));
  appServer = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => { mockServer.close(); appServer.close(); });

async function post(path, body, token = SECRET) {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test("health is open, everything else needs the bearer", async () => {
  const h = await fetch(base + "/health").then((r) => r.json());
  assert.equal(h.ok, true);
  const bad = await post("/schedule/identify", { phone: "4016397188" }, "wrong");
  assert.equal(bad.status, 401);
  const ro = await post("/ro-status", { ro_number: "100303" });
  assert.equal(ro.json.found, true); assert.match(ro.json.spoken, /paperwork/);
});

test("full booking flow: identify -> pick vehicle -> services -> slots -> book", async () => {
  const call = "call-1";
  const id = await post("/schedule/identify", { call_id: call, phone: "+14016397188" });
  assert.equal(id.json.found, true); assert.equal(id.json.vehicle_count, 2);
  assert.match(id.json.vehicles_spoken, /2023 Nissan Rogue, or the 2021 Nissan Frontier/);

     const unclear = await post("/schedule/select-vehicle", { call_id: call, vehicle_choice: "the blue one" });
  assert.equal(unclear.json.matched, false);
  const veh = await post("/schedule/select-vehicle", { call_id: call, vehicle_choice: "the Rogue" });
  assert.equal(veh.json.matched, true); assert.equal(veh.json.vehicle_spoken, "2023 Nissan Rogue");

     const svc = await post("/schedule/services", { call_id: call, services_text: "I need an oil change and my brakes are squeaking" });
  assert.equal(svc.json.bookable, true); assert.equal(svc.json.service_count, 2);
  assert.match(svc.json.services_spoken, /oil change/); assert.match(svc.json.services_spoken, /brake inspection/);
  assert.equal(svc.json.symptom_detected, true); assert.equal(svc.json.symptom_service_key, "brakes");

     const slots = await post("/schedule/slots", { call_id: call, transportation_choice: "I'll wait", preferred_text: "Tuesday morning", mileage: "about 42,000" });
  assert.equal(slots.json.found, true); assert.equal(slots.json.options_count, 2, "Tuesday morning: 8 and 11 (9:30 is full)");
  assert.match(slots.json.options_spoken, /Tuesday, .* at 8 AM/);
  assert.equal(slots.json.transportation_spoken, "wait at the dealership");
  // detection: mock only accepts `opcodes` and employeeId
     const cat = await fetch(base + "/schedule/catalog", { headers: { Authorization: `Bearer ${SECRET}` } }).then((r) => r.json());
  assert.equal(cat.detected.slotOpcodeField, "opcodes"); assert.equal(cat.detected.advisorField, "employeeId");
  assert.equal(cat.menu.find((m) => m.key === "oil_change").opcode, "LOF");

     const book = await post("/schedule/book", { call_id: call, slot_choice: "the first one" });
  assert.equal(book.json.booked, true); assert.equal(book.json.mode, "new"); assert.match(book.json.appointment_spoken, /Tuesday/);
  const created = state.created[0];
  assert.equal(created.customer.id, "cust-1"); assert.equal(created.vehicle.vin, "1N4BL4BV5NN000001"); assert.equal(created.vehicle.id, "veh-1");
  assert.equal(created.serviceAdvisorId, "E1001"); assert.equal(created.transportationTypeId, "tr-wait"); assert.equal(created.shopId, "shop-1");
  assert.deepEqual(created.jobs.map((j) => j.operations[0].opcode), ["LOF", "BRKINSP"]);
  assert.equal(created.postTaxTotalAmount.amount, 89);
  assert.match(created.customerComments, /mileage: 42000/);
  assert.equal(created.deliveryContactSameAsCustomer, true);

     const dup = await post("/schedule/book", { call_id: call, slot_choice: "first" });
  assert.equal(dup.json.duplicate, true); assert.equal(state.created.length, 1);
});

test("unknown request books a custom concern; recall requires advisor", async () => {
  const call = "call-2";
  await post("/schedule/identify", { call_id: call, phone: "4013007450" });
  const s1 = await post("/schedule/services", { call_id: call, services_text: "the sunroof drain is leaking into the headliner" });
  assert.equal(s1.json.bookable, true); assert.equal(s1.json.used_custom_concern, true);
  const s2 = await post("/schedule/services", { call_id: call, services_text: "I got a recall letter" });
  assert.equal(s2.json.bookable, false); assert.equal(s2.json.requires_advisor, true);
  const s3 = await post("/schedule/services", { call_id: call, services_text: "it pulls to the right on the highway" });
  assert.match(s3.json.services_spoken, /alignment/);
});

test("new customer path and same-day / lead-time policy", async () => {
  const call = "call-3";
  const id = await post("/schedule/identify", { call_id: call, phone: "4015550000" });
  assert.equal(id.json.found, false);
  const inc = await post("/schedule/new-customer", { call_id: call, phone: "4015550000", first_name: "Dana", last_name: "", vehicle_text: "2019 Altima" });
  assert.equal(inc.json.registered, false); assert.match(inc.json.missing, /last_name/);
  const reg = await post("/schedule/new-customer", { call_id: call, phone: "4015550000", first_name: "Dana", last_name: "Lee", vehicle_text: "it's a 2019 Nissan Altima" });
  assert.equal(reg.json.registered, true); assert.equal(reg.json.vehicle_spoken, "2019 Nissan Altima");
  await post("/schedule/services", { call_id: call, services_text: "oil change" });
  const slots = await post("/schedule/slots", { call_id: call, transportation_choice: "drop it off", preferred_text: "today" });
  assert.equal(slots.json.found, true);
  assert.equal(slots.json.requested_day_unavailable, true, "same-day is off, so today should be reported unavailable with alternates");
  const book = await post("/schedule/book", { call_id: call, slot_choice: "yes the first" });
  assert.equal(book.json.booked, true);
  const created = state.created.at(-1);
  assert.equal(created.customer.id, undefined); assert.equal(created.customer.firstName, "Dana"); assert.equal(created.customer.phones[0].number, "4015550000");
  assert.equal(created.vehicle.model, "Altima"); assert.equal(created.transportationTypeId, "tr-drop");
});

test("find, reschedule (jobs preserved), and cancel", async () => {
  const call = "call-4";
  const f = await post("/schedule/find", { call_id: call, phone: "4016397188" });
  assert.equal(f.json.found, true, JSON.stringify(f.json)); assert.equal(f.json.match_count, 1); assert.match(f.json.appointment_spoken, /2023 Nissan Rogue/);
  assert.match(f.json.services_spoken, /LUBE OIL FILTER/);

     const slots = await post("/schedule/slots", { call_id: call, preferred_text: "next week, afternoon" });
  assert.equal(slots.json.mode, "reschedule"); assert.equal(slots.json.found, true);
  assert.match(slots.json.options_spoken, /PM/);
  const book = await post("/schedule/book", { call_id: call, slot_choice: "Tuesday at 1" });
  assert.equal(book.json.booked, true, JSON.stringify(book.json)); assert.equal(book.json.mode, "reschedule"); assert.match(book.json.appointment_spoken, /1 PM/);
  const upd = state.updated[0];
  assert.equal(upd.id, "appt-1"); assert.equal(upd.jobs.length, 0); assert.equal(upd.updatedJobs.length, 2); assert.equal(upd.updatedJobs[0].id, "job-0");
  assert.equal(typeof upd.appointmentDateTime, "number"); assert.equal(upd.customer.id, "cust-1");

     const c = await post("/schedule/cancel", { call_id: call, cancel_reason: "going out of town" });
  assert.equal(c.json.cancelled, true);
  assert.deepEqual(state.cancelled[0], { id: "appt-1", cancelReason: "going out of town", donotNotifyCustomer: false });
  const f2 = await post("/schedule/find", { call_id: "call-5", phone: "4016397188" });
  assert.equal(f2.json.match_count, 0); assert.equal(f2.json.reason, "no_appointments");
});

test("multiple appointments: pick by vehicle", async () => {
  const call = "call-6";
  await post("/schedule/identify", { call_id: call, phone: "4016397188" });
  for (const choice of ["the Rogue", "the Frontier"]) {
    const c2 = `${call}-${choice}`;
    await post("/schedule/identify", { call_id: c2, phone: "4016397188" });
    await post("/schedule/select-vehicle", { call_id: c2, vehicle_choice: choice });
    await post("/schedule/services", { call_id: c2, services_text: "tire rotation" });
    await post("/schedule/slots", { call_id: c2, preferred_text: choice === "the Rogue" ? "Wednesday" : "Thursday" });
    const b = await post("/schedule/book", { call_id: c2, slot_choice: "first" });
    assert.equal(b.json.booked, true);
  }
  const f = await post("/schedule/find", { call_id: call, phone: "4016397188" });
  assert.equal(f.json.match_count, 2); assert.equal(f.json.found, false);
  const sel = await post("/schedule/select-appointment", { call_id: call, appointment_choice: "the Frontier" });
  assert.equal(sel.json.matched, true); assert.match(sel.json.appointment_spoken, /Frontier/);
});

test("knowledge answers", async () => {
  const h = await post("/schedule/answer", { question: "what are your hours on saturday" });
  assert.match(h.json.spoken, /Monday through Friday 7:30 AM to 5 PM, Saturday 7:30 AM to 4 PM, Sunday closed/);
  const w = await post("/schedule/answer", { question: "where are you located" });
  assert.equal(w.json.topic, "unknown", "location is answered from the Bland KB, not the service");
  const s = await post("/schedule/answer", { question: "my car is pulling to the right at high speeds" });
  assert.equal(s.json.topic, "symptom"); assert.equal(s.json.suggestService, "alignment"); assert.match(s.json.suggest_spoken, /alignment/);
});

test("call-context: spoken variables derived from live catalog and hours", async () => {
  const r = await fetch(`${base}/schedule/call-context`, { headers: { authorization: `Bearer ${SECRET}` } });
  const j = await r.json();
  assert.equal(j.ok, true); assert.equal(j.dealer_name, "Balise Nissan of Warwick");
  assert.match(j.service_hours_spoken, /Monday through Friday 7:30 AM to 5 PM/);
  assert.match(j.menu_spoken, /an oil change/); assert.match(j.menu_spoken, /a tire rotation/); assert.doesNotMatch(j.menu_spoken, /wiper/, "unresolved opcodes are not offered");
  assert.equal(j.menu_count, "6"); assert.equal(j.catalog_ok, "true"); assert.equal(j.custom_concern_available, "true");
  assert.match(j.transportation_spoken, /wait at the dealership/); assert.match(j.transportation_spoken, /loaner/);
  assert.ok(["true", "false"].includes(j.open_now));
  const unauth = await fetch(`${base}/schedule/call-context`);
  assert.equal(unauth.status, 401);
});

test("opcode picks: the model chooses from the store's real list, service matches exactly", async () => {
  const ctx = await (await fetch(`${base}/schedule/call-context`, { headers: { authorization: `Bearer ${SECRET}` } })).json();
  assert.match(ctx.opcode_options, /sunroof drain clean & leak check/); assert.match(ctx.opcode_options, /60,000 mile service/);
  assert.doesNotMatch(ctx.opcode_options, /warranty/, "internal and warranty codes are never offered");
  const call = "call-picks";
  await post("/schedule/identify", { call_id: call, phone: "4016397188" });
  await post("/schedule/select-vehicle", { call_id: call, vehicle_choice: "the Rogue" });
  const svc = await post("/schedule/services", { call_id: call, services_text: "water is coming in around the sunroof and I'm due for the sixty thousand mile", opcode_picks: "Sunroof drain clean & leak check; 60,000 mile service" });
  assert.equal(svc.json.bookable, true); assert.equal(svc.json.matched_via, "opcode_picks"); assert.equal(svc.json.service_count, 2);
  assert.match(svc.json.services_spoken, /sunroof/); assert.match(svc.json.services_spoken, /60,000 mile/);
  const bad = await post("/schedule/services", { call_id: call, services_text: "sunroof leak", opcode_picks: "Sunroof replacement (not a real option)" });
  assert.equal(bad.json.matched_via, "custom_concern", "a pick that is not on the list is ignored, never invented");
});

test("dealer config: env override and menu tweaks merge over defaults", async () => {
  const { loadDealerConfig } = await import("../dealer.js");
  process.env.DEALER_CONFIG_JSON = JSON.stringify({ dealerName: "Test Motors", hours: { service: { sun: ["09:00", "12:00"] } }, booking: { allowSameDay: true }, services: { menuExclude: ["wipers"], menuOverrides: { oil_change: { spoken: "a synthetic oil service" } }, menuAdd: [{ key: "detail", spoken: "a detail", callerPhrases: ["detail"], descriptionContains: ["detail"] }] } });
  const saveDealerId = process.env.TEKION_DEALER_ID; delete process.env.TEKION_DEALER_ID;
  try {
    const c = loadDealerConfig();
    assert.equal(c.dealerName, "Test Motors"); assert.equal(c._source, "env:DEALER_CONFIG_JSON");
    assert.deepEqual(c.hours.service.sun, ["09:00", "12:00"]); assert.deepEqual(c.hours.service.mon, ["07:30", "17:00"], "unspecified days keep defaults");
    assert.equal(c.booking.allowSameDay, true); assert.equal(c.booking.horizonDays, 30);
    const keys = c.services.menu.map((m) => m.key);
    assert.ok(!keys.includes("wipers")); assert.ok(keys.includes("detail"));
    assert.equal(c.services.menu.find((m) => m.key === "oil_change").spoken, "a synthetic oil service");
    assert.equal(c.services.menu.find((m) => m.key === "recall").requiresAdvisor, true);
  } finally { delete process.env.DEALER_CONFIG_JSON; if (saveDealerId) process.env.TEKION_DEALER_ID = saveDealerId; }
});
