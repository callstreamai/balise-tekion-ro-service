// Time helpers for a fixed dealer time zone. Node's Intl handles DST; we never hand-roll offsets.

export function makeTz(timeZone) {
  const partsFmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Local wall-clock parts for an instant.
function parts(epochMs) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
}
  function offsetMs(epochMs) {
    const p = parts(epochMs);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(epochMs / 1000) * 1000;
  }
  // Instant for a local wall-clock time (y, m 1-12, d, h, mi).
function toEpoch(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const e1 = guess - offsetMs(guess);
  return e1 - (offsetMs(e1) - offsetMs(guess)); // second pass handles DST edges
}
  function ymd(epochMs) { const p = parts(epochMs); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }
  function startOfDay(epochMs) { const p = parts(epochMs); return toEpoch(p.y, p.m, p.d); }
  function addDays(epochMs, n) { const p = parts(epochMs); return toEpoch(p.y, p.m, p.d + n, p.h, p.mi); }
  function minutesOfDay(epochMs) { const p = parts(epochMs); return p.h * 60 + p.mi; }

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const wdFmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" });
  function spokenDay(epochMs) { return dayFmt.format(new Date(epochMs)); }
  function spokenTime(epochMs) { return timeFmt.format(new Date(epochMs)).replace(":00", ""); }
  function spokenDateTime(epochMs) { return `${spokenDay(epochMs)} at ${spokenTime(epochMs)}`; }
  function weekdayName(epochMs) { return wdFmt.format(new Date(epochMs)); }

return { timeZone, parts, toEpoch, ymd, startOfDay, addDays, minutesOfDay, spokenDay, spokenTime, spokenDateTime, weekdayName };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

// Parse a caller's spoken preference ("Tuesday morning", "next week", "the 22nd around 3", "as soon as possible")
// into a search window and time-of-day filter, in the dealer's zone. Returns null fields when unspecified.
export function parsePreference(text, tz, now = Date.now()) {
  const t = String(text ?? "").toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  const out = { dayEpoch: null, rangeStart: null, rangeEnd: null, timeOfDay: null, hour: null, asap: false, raw: t };
  const today = tz.startOfDay(now);
  const p = tz.parts(now);

if (!t || /\b(asap|soon|soonest|earliest|first available|whenever|any ?time|next available|as soon)\b/.test(t)) out.asap = true;

if (/\btomorrow\b/.test(t)) out.dayEpoch = tz.addDays(today, 1);
  else if (/\bday after tomorrow\b/.test(t)) out.dayEpoch = tz.addDays(today, 2);
  else if (/\btoday\b/.test(t)) out.dayEpoch = today;

const wdMatch = WEEKDAYS.map((w, i) => (new RegExp(`\\b${w.slice(0, 3)}[a-z]*\\b`).test(t) ? i : -1)).filter((i) => i >= 0);
  if (wdMatch.length && out.dayEpoch === null) {
    const target = wdMatch[0];
    let delta = (target - p.wd + 7) % 7;
    if (delta === 0) delta = 7; // "Tuesday" said on a Tuesday means next Tuesday
  if (/\bnext\b/.test(t) && delta <= 2) delta += 7; // "next Friday" said on Thursday
  out.dayEpoch = tz.addDays(today, delta);
  }

const mdMatch = t.match(new RegExp(`\\b(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  const dmMatch = t.match(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/);
  const numMatch = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (out.dayEpoch === null && (mdMatch || dmMatch || numMatch)) {
    let month = p.m, day;
    if (mdMatch) { month = MONTHS.findIndex((m) => m.startsWith(mdMatch[1].slice(0, 3))) + 1; day = +mdMatch[2]; }
    else if (numMatch) { month = +numMatch[1]; day = +numMatch[2]; }
    else day = +dmMatch[1];
    let year = p.y;
    let cand = tz.toEpoch(year, month, day);
    if (cand < today) cand = tz.toEpoch(year + 1, month, day);
    out.dayEpoch = cand;
  }

if (out.dayEpoch === null) {
  if (/\bnext week\b/.test(t)) { const toMon = ((8 - p.wd) % 7) || 7; out.rangeStart = tz.addDays(today, toMon); out.rangeEnd = tz.addDays(out.rangeStart, 5); }
  else if (/\bthis week\b/.test(t)) { out.rangeStart = today; out.rangeEnd = tz.addDays(today, (6 - p.wd)); }
  else if (/\bweekend\b|\bsaturday\b/.test(t)) { const toSat = ((6 - p.wd + 7) % 7) || 7; out.rangeStart = tz.addDays(today, toSat); out.rangeEnd = out.rangeStart; }
  else if (/\bnext month\b/.test(t)) { out.rangeStart = tz.toEpoch(p.y, p.m + 1, 1); out.rangeEnd = tz.addDays(out.rangeStart, 6); }
}

if (/\bmorning|\bearly\b|before noon|\bam\b/.test(t) && !/\bafter ?noon\b/.test(t)) out.timeOfDay = "morning";
  else if (/\bafter ?noon\b|\blate\b|after lunch|\bevening\b|\bpm\b/.test(t)) out.timeOfDay = "afternoon";
  else if (/\bmidday|\bnoon|lunch/.test(t)) out.timeOfDay = "midday";

const hm = t.match(/\b(?:at|around|about|by)?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm|a m|p m|o'?clock)?\b/);
  if (hm && !mdMatch && !numMatch && !dmMatch) {
    let h = NUM_WORDS[hm[1]] ?? +hm[1];
    if (h >= 1 && h <= 12) {
      const ap = (hm[3] || "").replace(/\s/g, "");
      if (ap.startsWith("p") && h < 12) h += 12;
      else if (!ap && h < 7) h += 12; // "at 3" means 3 PM at a service department
    out.hour = h + (hm[2] ? +hm[2] / 60 : 0);
    }
  }
  return out;
}

// Pick one of N spoken options from the caller's reply: ordinal words, "last", or a time/day mention.
export function matchChoice(text, options, tz) {
  const t = String(text ?? "").toLowerCase();
  if (!options?.length) return null;
  // Ordinals. Bare "one"/"two"/"three" are excluded: "the blue one" and "the 1 PM one" are not ordinals.
if (/\b(first|1st|earliest|soonest|number one|option one)\b/.test(t) && !/\bnot the first\b/.test(t)) return 0;
  if (/\b(second|2nd|middle|number two|option two)\b/.test(t)) return options.length > 1 ? 1 : null;
  if (/\b(third|3rd|number three|option three)\b/.test(t)) return options.length > 2 ? 2 : null;
  if (/^\s*(1|2|3)\s*$/.test(t)) { const i = Number(t) - 1; return i < options.length ? i : null; }
  if (/\b(last|latest)\b/.test(t)) return options.length - 1;
  if (options.length === 1 && /\b(yes|yeah|yep|sure|that works|fine|ok|okay|perfect|great|book it|take it|sounds good)\b/.test(t)) return 0;
  const pref = parsePreference(t, tz);
  const scored = options.map((o, i) => {
    let s = 0;
    if (pref.hour !== null && Math.abs(tz.minutesOfDay(o.startTime) / 60 - pref.hour) < 0.26) s += 2;
    if (pref.dayEpoch !== null && tz.ymd(o.startTime) === tz.ymd(pref.dayEpoch)) s += 1;
    if (pref.timeOfDay === "morning" && tz.minutesOfDay(o.startTime) < 12 * 60) s += 0.5;
    if (pref.timeOfDay === "afternoon" && tz.minutesOfDay(o.startTime) >= 12 * 60) s += 0.5;
    return { i, s };
  }).sort((a, b) => b.s - a.s);
  if (scored[0].s > 0 && (scored.length === 1 || scored[0].s > scored[1].s)) return scored[0].i;
  return null;
}
