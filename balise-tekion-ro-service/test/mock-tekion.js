// Minimal Tekion stand-in for local tests. Deliberately picky about the two ambiguous fields:
// Slots accepts only `opcodes` (not `opcode`) and only serviceAdvisorId values that match employeeId,
// so the service's startup detection is exercised.
import express from "express";
import { makeTz } from "../timeutil.js";

const tz = makeTz("America/New_York");
export function makeMock() {
  const state = { appointments: [], created: [], updated: [], cancelled: [], calls: [] };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { state.calls.push(`${req.method} ${req.path}`); next(); });

app.post("/openapi/public/tokens", express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.app_id !== "app" || req.body.secret_key !== "secret") return res.status(401).json({ message: "bad creds" });
  res.json({ data: { access_token: "tok-" + Date.now(), expire_on: Date.now() + 86400000 } });
});
  const guard = (req, res, next) => {
    if (req.get("authorization") !== "Bearer " + req.get("authorization")?.slice(7) || !req.get("dealer_id")) return res.status(401).json({ message: "unauthorized" });
    next();
  };
  app.use("/openapi/v3.1.0", guard);
  app.use("/openapi/v4.0.0", guard);

const customers = [
  { id: "cust-1", arcId: "A1", customerType: "INDIVIDUAL", firstName: "Pennie", lastName: "Smith", companyName: "", status: "ACTIVE", phones: [{ phoneType: "MOBILE", number: "4016397188", isPrimary: true }], preferredContactType: "CALL", email: "p@example.com",
   vehicleInfo: [{ vin: "1N4BL4BV5NN000001", last8DigitVIN: "NN000001", vehicleId: "veh-1", year: "2023", make: "Nissan", model: "Rogu" }, { vin: "1N6ED1EK5PN000002", vehicleId: "veh-2", year: "2021", make: "Nissan", model: "Frontier" }],
   addresses: [{ isCurrent: true, line1: "1 Main St", line2: "", city: "Warwick", state: "RI", country: "US", zip: "02888", county: "Kent" }] },
  { id: "cust-2", customerType: "INDIVIDUAL", firstName: "Morris", lastName: "Jones", companyName: "", status: "ACTIVE", phones: [{ phoneType: "HOME", number: "4013007450", isPrimary: true }], email: "", vehicleInfo: [{ vin: "5N1AT2MV0HC000003", vehicleId: "veh-3", year: "2017", make: "Nissan", model: "Rogue" }] },
  ];
  app.get("/openapi/v3.1.0/customers", (req, res) => {
    const { phone, id } = req.query;
    let data = customers;
    if (id) data = data.filter((c) => c.id === id);
    if (phone) data = data.filter((c) => c.phones.some((p) => p.number.replace(/\D/g, "").endsWith(String(phone).replace(/\D/g, "").slice(-10))));
    res.json({ meta: { status: "success", total: data.length, pages: 1, count: data.length, currentPage: 1 }, data });
  });
  app.get("/openapi/v3.1.0/service-shops", (_req, res) => res.json({ meta: { status: "success" }, data: [{ id: "shop-1", name: "Main Shop", status: "ACTIVE", isDefault: true }, { id: "shop-2", name: "Express", status: "ACTIVE", isDefault: false }] }));
  app.get("/openapi/v3.1.0/transportation-types", (_req, res) => res.json({ meta: { status: "success" }, data: [{ id: "tr-wait", name: "Waiter", status: "ACTIVE" }, { id: "tr-drop", name: "Drop Off", status: "ACTIVE" }, { id: "tr-shuttle", name: "Shuttle", status: "ACTIVE" }, { id: "tr-loaner", name: "Loaner Vehicle", status: "ACTIVE" }] }));
  app.get("/openapi/v3.1.0/employees", (_req, res) => res.json({ meta: { status: "success" }, data: [{ id: "emp-uuid-1", email: "a@b.c", fname: "Sam", lname: "Advisor", displayName: "Sam Advisor", employeeId: "E1001", employeeDisplayNumber: "TEK07", role: "ServiceAdvisor", isActive: true }] }));
  const opcodes = [
    { opcode: "LOF", description: "LUBE OIL FILTER - SYNTHETIC", category: "MAINT", defaultPayType: "CUSTOMER_PAY", laborTimeInSeconds: 1800, priceDetails: [{ payType: "CUSTOMER_PAY", flatPrice: { amount: 89, currency: "USD" } }] },
    { opcode: "ROT", description: "TIRE ROTATION", defaultPayType: "CUSTOMER_PAY", priceDetails: [{ payType: "CUSTOMER_PAY", flatPrice: { amount: 29, currency: "USD" } }] },
    { opcode: "MPI", description: "MULTI POINT INSPECTION", defaultPayType: "CUSTOMER_PAY" },
    { opcode: "BRKINSP", description: "BRAKE INSPECTION", defaultPayType: "CUSTOMER_PAY" },
    { opcode: "ALIGN", description: "4 WHEEL ALIGNMENT", defaultPayType: "CUSTOMER_PAY", priceDetails: [{ payType: "CUSTOMER_PAY", flatPrice: { amount: 129.99, currency: "USD" } }] },
    { opcode: "BATT", description: "BATTERY TEST", defaultPayType: "CUSTOMER_PAY" },
    { opcode: "CC", description: "CUSTOMER CONCERN", defaultPayType: "CUSTOMER_PAY" },
    ];
  app.get("/openapi/v3.1.0/opcodes", (req, res) => {
    if (req.query.customConcern === "true") return res.json({ meta: { status: "success" }, data: [opcodes.find((o) => o.opcode === "CC")] });
    res.json({ meta: { status: "success", total: opcodes.length, pages: 1 }, data: opcodes });
  });
  app.post("/openapi/v3.1.0/appointment-slots", (req, res) => {
    const b = req.body;
    if ("opcode" in b) return res.status(400).json({ message: "Unrecognized field opcode" });
    if (b.serviceAdvisorId !== "E1001") return res.status(400).json({ message: "Invalid serviceAdvisorId" });
    for (const k of ["shopId", "transportationId", "startDate", "endDate"]) if (!b[k]) return res.status(400).json({ message: `missing ${k}` });
    const [sy, sm, sd] = b.startDate.split("-").map(Number), [ey, em, ed] = b.endDate.split("-").map(Number);
    const data = [];
    for (let t = tz.toEpoch(sy, sm, sd); t <= tz.toEpoch(ey, em, ed); t = tz.addDays(t, 1)) {
      const p = tz.parts(t);
      const closed = p.wd === 0;
      const slots = closed ? [] : [8, 9.5, 11, 13, 15, 16.5].map((h) => ({ startTime: tz.toEpoch(p.y, p.m, p.d, Math.floor(h), (h % 1) * 60), endTime: tz.toEpoch(p.y, p.m, p.d, Math.floor(h), (h % 1) * 60) + 1800000, capacity: 3, booked: h === 9.5 ? 3 : 1, isAvailable: h !== 9.5 }));
      data.push({ appointmentDate: t, isClosed: closed, status: "OPEN", booked: 0, capacity: 18, slots });
    }
    res.json({ status: "success", data });
  });
  app.post("/openapi/v3.1.0/appointments", (req, res) => {
    const b = req.body;
    for (const k of ["shopId", "transportationTypeId", "serviceAdvisorId", "appointmentDateTime", "customer", "vehicle", "deliveryContactSameAsCustomer", "jobs", "notifyCustomer", "postTaxTotalAmount"]) if (b[k] === undefined) return res.status(400).json({ message: `missing ${k}` });
    if (typeof b.appointmentDateTime !== "number") return res.status(400).json({ message: "appointmentDateTime must be epoch ms" });
    const appt = { ...b, id: "appt-" + (state.created.length + 1), number: "A100" + (state.created.length + 1), status: "SCHEDULED", appointmentNumber: "A100" + (state.created.length + 1), jobs: b.jobs.map((j, i) => ({ ...j, id: `job-${i}`, operations: j.operations.map((o, k) => ({ ...o, id: `op-${i}-${k}` })) })) };
    state.created.push(appt); state.appointments.push(appt);
    res.json({ status: "success", data: appt });
  });
  app.put("/openapi/v3.1.0/appointments", (req, res) => {
    const b = req.body;
    const a = state.appointments.find((x) => x.id === b.id);
    if (!a) return res.status(400).json({ message: "unknown appointment" });
    if (typeof b.appointmentDateTime !== "number") return res.status(400).json({ message: "appointmentDateTime must be epoch ms" });
    if (!Array.isArray(b.jobs)) return res.status(400).json({ message: "jobs required" });
    a.appointmentDateTime = b.appointmentDateTime; state.updated.push(b);
    res.json({ status: "success", data: { ...a, appointmentNumber: a.appointmentNumber } });
  });
  app.post("/openapi/v3.1.0/appointments/cancel", (req, res) => {
    const b = req.body;
    if (!b.id || !b.cancelReason || typeof b.donotNotifyCustomer !== "boolean") return res.status(400).json({ message: "bad cancel body" });
    const a = state.appointments.find((x) => x.id === b.id);
    if (!a) return res.status(400).json({ message: "unknown appointment" });
    a.status = "CANCELLED"; state.cancelled.push(b);
    res.json({ status: "success", data: "Appointment cancelled" });
  });
  app.get("/openapi/v3.1.0/appointments", (req, res) => {
    const { customerId, id, appointmentStartTime, appointmentEndTime } = req.query;
    let data = state.appointments;
    if (id) data = data.filter((a) => a.id === id);
    if (customerId) data = data.filter((a) => a.customer?.id === customerId);
    if (appointmentStartTime) data = data.filter((a) => a.appointmentDateTime >= Number(appointmentStartTime));
    if (appointmentEndTime) data = data.filter((a) => a.appointmentDateTime <= Number(appointmentEndTime));
    res.json({ meta: { status: "success", total: data.length, pages: 1, count: data.length, currentPage: 1 }, data });
  });
  app.post("/openapi/v4.0.0/repair-orders:search", (req, res) => {
    const f = Object.fromEntries((req.body.filters ?? []).map((x) => [x.field, x.values]));
    const ros = [{ documentNumber: "100303", status: "READY_FOR_INVOICE", vin: "1N4BL4BV5NN000001", creationTime: Date.now() - 86400000, schedule: [] }];
    let results = ros;
    if (f.documentNumber) results = results.filter((r) => f.documentNumber.includes(r.documentNumber));
    if (f.vin) results = results.filter((r) => f.vin.includes(r.vin));
    if (req.body.textSearch) results = [];
    res.json({ meta: { totalCount: results.length }, data: { results } });
  });

return { app, state, seedAppointment(a) { state.appointments.push(a); } };
}
