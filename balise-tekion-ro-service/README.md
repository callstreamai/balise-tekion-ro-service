# Balise Nissan of Warwick: Ava service agent backend (Tekion)

Node/Express service that Bland calls during a live call. It owns the Tekion token exchange and turns Tekion's APIs into small, spoken-ready webhook responses.

| Capability | Endpoint(s) | Tekion APIs (v3.1.0 unless noted) |
|---|---|---|
| Repair order status by RO number or phone | `POST /ro-status` | Repair Order Search (v4), Appointment Search |
| Identify customer and vehicles by phone | `POST /schedule/identify`, `/select-vehicle`, `/new-customer` | Get Customers, Appointment Search (fallback) |
| Match the caller's words to bookable services | `POST /schedule/services` | Opcode API (catalog + custom concern opcode) |
| Open times, with dealer policy applied | `POST /schedule/slots` | Service Shops, Transportation, Employees, Appointment Slots |
| Book, or move an existing appointment | `POST /schedule/book` | Appointment Create, Update Appointment |
| Find and pick an upcoming appointment | `POST /schedule/find`, `/select-appointment` | Appointment Search |
| Cancel | `POST /schedule/cancel` | Appointment Cancel |
| Hours, location, amenities, symptom guidance | `POST /schedule/answer` (also baked into the pathway prompts) | none (dealer-config.json) |
| Diagnostics | `GET /health`, `GET /diag`, `GET /diag/matches`, `GET /diag/upcoming`, `GET /schedule/catalog` | |

All `POST` routes and the `/diag*` and `/schedule/catalog` routes require `Authorization: Bearer <WEBHOOK_SECRET>`.

## Files

`server.js` is the HTTP app, auth, RO status, diagnostics, and startup self-check. `scheduling.js` holds the scheduling endpoints, per-call session state (keyed by Bland `call_id`), catalog cache, slot policy, and payload builders. `tekion.js` is the token cache and versioned GET/POST/PUT with dealer headers and 401 retry. `appointment-index.js` builds the phone to vehicle/appointment index from Appointment Search (one 7-day window, refreshed every 15 minutes). `timeutil.js` handles dealer time zone math, spoken dates, and parsing "Tuesday morning" / "next week" / "the 22nd around 3".

`dealer-config.json` is everything Balise can change without code: hours, address, phones, menu of bookable services, transportation options, booking policy, symptom guidance, arrival and cancellation wording.

`pathway/build-pathway.mjs` generates the Bland pathway from the previous export plus the config (kept in the project folder; output `balise-nissan-service-agent.json`). `test/` has a mock Tekion and end-to-end tests (`npm test`).

## Environment variables (Render)

| Name | Value |
|---|---|
| `TEKION_BASE` | `https://api.tekioncloud.com/openapi` (production) or `https://api-sandbox.tekioncloud.com/openapi` |
| `TEKION_APP_ID` | APC application id |
| `TEKION_SECRET_KEY` | APC secret (secret; rotate the one that was pasted in chat) |
| `TEKION_DEALER_ID` | `baliseautogroup_7772_0` (Balise Nissan of Warwick) |
| `WEBHOOK_SECRET` | Bearer token Bland sends; same value in every webhook node |
| `DEALER_NAME` | `Balise Nissan of Warwick` |
| `APPT_REFRESH_MINUTES` | optional, default 15 |
| `SELFCHECK_PHONE` | optional; a phone to probe in the startup self-check |

## How a scheduling call flows

`identify` runs with caller ID: Tekion Get Customers filtered by `phone`. One vehicle: confirm it. Several: the caller picks and `select-vehicle` matches "the Rogue" or "the 2021". None: ask the phone on the account, then set up a new customer and vehicle (`new-customer`); the create call carries them without ids.

`services` matches the caller's words to `dealer-config.json > services.menu` (opcodes resolved at startup from the dealer's Tekion catalog by description keywords). Anything unmatched is booked as Tekion's custom concern opcode with the caller's words as the job concern. Items flagged `requiresAdvisor` (recall, loaner) route to a warm transfer with context.

`slots` picks the default shop, a service advisor, and the transportation type, parses the caller's preference, calls Appointment Slots, applies policy (no same day, 2-hour lead, 30-day horizon, service hours), and offers up to 3 spread-out times.

`book` matches "the first one" or "Tuesday at 8" to an offer and posts Appointment Create. For a reschedule (the session holds an existing appointment) it posts Update Appointment with the same jobs in `updatedJobs`. Duplicate calls for the same slot return the earlier result.

`find` lists upcoming appointments for the customer (`customerId` filter, with the appointment index as a phone fallback); `select-appointment` picks one; `cancel` posts Appointment Cancel.

## Spec conflicts and how the service handles them

| Conflict (from REVIEW.md) | Handling |
|---|---|
| Slots field `opcode` vs `opcodes` | `booking.slotOpcodeField: "auto"` tries `opcode`, falls back to `opcodes` on 400, remembers the answer. Visible in `GET /schedule/catalog > detected`. |
| Which employee field is `serviceAdvisorId` | `booking.serviceAdvisorIdField: "auto"` probes `employeeDisplayNumber`, `employeeId`, `id` against the free Slots API once. Pin it in config once known. |
| `donotNotifyCustomer` semantics | `booking.cancelNotifyFlagValue: false` (safe under either reading). Confirm with Tekion before changing. |
| Update `appointmentDateTime` int vs ISO | `booking.updateTimestampFormat: "epoch"`; switch to `"iso"` if Tekion rejects. |
| Jobs on reschedule | `booking.rescheduleJobsMode: "updatedJobs"`; alternative `"jobs"`. Verify in the first live reschedule that the work stayed on the ticket. |
| Mileage persistence | No Vehicle Update field exists. Reported mileage goes into `customerComments`. |
| Unpriced work / `postTaxTotalAmount` | Sum of catalog flat prices for matched opcodes, else 0. The agent never quotes prices. |

## Before Balise goes live

Confirm hours in `dealer-config.json` (the website says service Mon to Fri 7:30 to 5, Sat 7:30 to 4; NissanUSA says 8 to 5 and 8 to 2). Have the service manager review `services.menu`: `GET /schedule/catalog` shows which menu items resolved to which opcodes (`menuUnresolved` lists the misses); pin exact opcodes and set `requiresAdvisor` per item. Decide loaner/shuttle policy (`transportation.options`), same-day policy, horizon, and advisor routing (`defaultServiceAdvisorId` or `allowedServiceAdvisorIds`). Run one end-to-end test booking on a designated test customer, read it back in Tekion, then one reschedule (check jobs preserved) and one cancel (check who got notified). Set the transfer numbers in the pathway (`DID_TBD_BALISE_SERVICE`). Rotate the Tekion secret and make the GitHub repo private.

## Local development

```bash
npm install
npm test
node pathway/build-pathway.mjs <bland-export.json>
```
