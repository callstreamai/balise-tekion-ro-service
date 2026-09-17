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
| Live call context for the pathway (menu, hours, transportation, spoken) | `GET /schedule/call-context` | Opcode, Service Shops, Transportation, Employees (cached) |
| Hours (everything else is answered from the Bland knowledge base) | `POST /schedule/answer` | none |
| Diagnostics | `GET /health`, `GET /diag`, `GET /diag/matches`, `GET /diag/upcoming`, `GET /schedule/catalog` | |

All `POST` routes and the `/diag*`, `/schedule/catalog` and `/schedule/call-context` routes require `Authorization: Bearer <WEBHOOK_SECRET>`.

## Files

- `server.js`: HTTP app, auth, RO status, diagnostics, startup self-check.
- `scheduling.js`: scheduling endpoints, per-call session state (keyed by Bland `call_id`), catalog cache, slot policy, payload builders.
- `tekion.js`: token cache, versioned GET/POST/PUT with dealer headers, 401 retry.
- `appointment-index.js`: phone to vehicle/appointment index from Appointment Search (one 7-day window, refreshed every 15 minutes).
- `timeutil.js`: dealer time zone math, spoken dates, parsing "Tuesday morning" / "next week" / "the 22nd around 3".
- `dealer.js`: loads `service-defaults.json` and overlays one store's settings from `DEALER_CONFIG_JSON` (env), `DEALER_CONFIG_PATH`, or `dealer-config.json`.
- `service-defaults.json`: shared defaults for every store: booking policy, transportation options, the generic services menu (matched against each store's live Tekion opcodes by description keywords), symptom-to-service hints.
- `dealer-config.json`: the one store's operational overrides only (dealer id, time zone, service hours, booking policy, menu tweaks). No caller-facing text lives here.
- `pathway/build-pathway.mjs` (kept in the project folder, not in this repo): generates the Bland pathway from the previous export plus `pathway/store-knowledge.md`, the store's plain-language knowledge (location, amenities, arrival, policies, symptom guidance). That text is embedded in the pathway's Knowledge Base nodes and is meant to be edited in Bland afterwards, or uploaded as a Bland vector knowledge base.
- `test/`: mock Tekion + end-to-end tests (`npm test`).

## Environment variables (Render)

| Name | Value |
|---|---|
| `TEKION_BASE` | `https://api.tekioncloud.com/openapi` (production) or `https://api-sandbox.tekioncloud.com/openapi` |
| `TEKION_APP_ID` | APC application id |
| `TEKION_SECRET_KEY` | APC secret (never commit it) |
| `TEKION_DEALER_ID` | `baliseautogroup_7772_0` (Balise Nissan of Warwick) |
| `WEBHOOK_SECRET` | Bearer token Bland sends; same value in every webhook node |
| `DEALER_NAME` | `Balise Nissan of Warwick` |
| `DEALER_CONFIG_JSON` | optional; a JSON object with the same keys as `dealer-config.json`. When set, it replaces the file, so a store's hours or booking policy can change from the hosting dashboard without a deploy of code |
| `APPT_REFRESH_MINUTES` | optional, default 15 |
| `SELFCHECK_PHONE` | optional; a phone to probe in the startup self-check |

## Where things live

| Kind of information | Lives in | Edited by |
|---|---|---|
| Opcodes, shops, advisors, transportation types, open slots | Tekion, read live by this service | the store, in Tekion |
| Which of the store's opcodes a caller's request means | the model, choosing from the live list the service hands the pathway at call start | nobody; it adapts to each store's naming |
| Booking policy, service hours, menu tweaks, Tekion field quirks | store config (`DEALER_CONFIG_JSON` or `dealer-config.json`) | engineering, or anyone with dashboard access |
| Location, directions, amenities, arrival, policies, symptom guidance | the pathway's Knowledge Base nodes (from `pathway/store-knowledge.md`) or an uploaded Bland knowledge base | the team, in Bland |
| Greeting, transfer numbers, voice, turn-taking | the Bland pathway | the team, in Bland |

At the start of every call the pathway calls `GET /schedule/call-context` and receives the live menu, today's hours, and the transportation options as `ctx_*` variables, so the pathway never hard-codes a menu or hours.

## How a scheduling call flows

1. `identify` with caller ID. Tekion Get Customers filtered by `phone`. One vehicle: confirm it. Several: caller picks; `select-vehicle` matches "the Rogue" / "the 2021". None: ask the phone on the account, then set up a new customer and vehicle (`new-customer`); the create call carries them without ids.
2. `services` resolves what to book in three tiers. First, `opcode_picks`: at call start the pathway received the store's real bookable opcode descriptions (`call-context > opcode_options`), the model picked the closest entries in the store's own words, and the service accepts those only on an exact description match (so nothing invented reaches Tekion). Second, the keyword menu (defaults in `service-defaults.json`, store tweaks in the store config; opcodes resolved at startup from the dealer's Tekion catalog by description keywords). Third, anything still unmatched is booked as Tekion's **custom concern** opcode with the caller's words as the job concern. Items flagged `requiresAdvisor` (recall, loaner) route to a warm transfer with context.
3. `slots` picks the default shop, a service advisor, and the transportation type, parses the caller's preference, calls Appointment Slots, applies policy (no same day, 2-hour lead, 30-day horizon, service hours), and offers up to 3 spread-out times.
4. `book` matches "the first one" / "Tuesday at 8" to an offer and posts Appointment Create. For a reschedule (session holds an existing appointment) it posts Update Appointment with the same jobs in `updatedJobs`. Duplicate calls for the same slot return the earlier result.
5. `find` lists upcoming appointments for the customer (`customerId` filter, with the appointment index as a phone fallback); `select-appointment` picks one; `cancel` posts Appointment Cancel.

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

1. Confirm service hours in `dealer-config.json` (or `DEALER_CONFIG_JSON`) and the store facts in `pathway/store-knowledge.md`.
2. Have the service manager review the menu: `GET /schedule/catalog` shows which default menu items resolved to which of the store's opcodes (`menuUnresolved` lists the misses). Adjust with `services.menuOverrides`, `menuExclude`, `menuAdd` in the store config; pin an exact `opcode` where the keyword match picked the wrong one.
3. Decide loaner/shuttle policy (`transportation.options`), same-day policy, horizon, and the advisor routing (`defaultServiceAdvisorId` or `allowedServiceAdvisorIds`).
4. Run one end-to-end test booking on a designated test customer, read it back in Tekion, then one reschedule (check jobs preserved) and one cancel (check who got notified).
5. Set the three transfer numbers in the pathway (`DID_TBD_BALISE_SERVICE`).
6. Make the GitHub repo private.

## Local development

```bash
npm install
npm test                                   # mock Tekion, full flows
node pathway/build-pathway.mjs <bland-export.json>   # regenerate the pathway after config edits
```
