// @ts-check
/**
 * Small formatting rules every view shares: times, scope-unique short handles, parties and coverage tokens. All times are stored in
 * UTC; a view converts to the tenant's time zone only here, when it prints.
 */
import { formatHandle } from "./handle.mjs";

/** @typedef {import("../proof/evidence.mjs").Window} Window */
/** @typedef {import("../proof/evidence.mjs").Uncovered} Uncovered */

/** A handle to be shortened once the whole view is known: `{ $h: kind, id }`. */
/** @typedef {{ $h: string, id: string }} Ref */

/** @param {string} kind @param {string} id @returns {Ref} */
export const ref = (kind, id) => ({ $h: kind, id });

/** The shortest id prefix a short handle shows; collisions inside one view lengthen it. */
const MIN_HANDLE = 4;

/**
 * Replaces every Ref in the view with a handle that is unique among the view's handles of the same kind, at least four characters
 * after the prefix. The same id always gets the same handle within one view.
 * @template T
 * @param {T} view
 * @returns {T}
 */
export function finalizeHandles(view) {
  /** @type {Map<string, Set<string>>} */
  const byKind = new Map();
  walk(view, (value) => {
    if (isRef(value)) byKind.set(value.$h, (byKind.get(value.$h) ?? new Set()).add(formatHandle(value.$h, value.id)));
  });
  /** @type {Map<string, string>} */
  const short = new Map();
  for (const handles of byKind.values()) {
    const list = [...handles];
    for (const full of list) {
      const start = full.indexOf("_") + 1;
      let length = Math.min(full.length, start + MIN_HANDLE);
      while (length < full.length && list.some((other) => other !== full && other.startsWith(full.slice(0, length)))) length += 1;
      short.set(full, full.slice(0, length));
    }
  }
  return /** @type {T} */ (replace(view, (value) => (isRef(value) ? short.get(formatHandle(value.$h, value.id)) : undefined)));
}

/** @param {unknown} value @returns {value is Ref} */
const isRef = (value) => typeof value === "object" && value !== null && "$h" in value && "id" in value;

/** @param {unknown} value @param {(value: unknown) => void} visit */
function walk(value, visit) {
  visit(value);
  if (value !== null && typeof value === "object") for (const child of Object.values(value)) walk(child, visit);
}

/**
 * @param {unknown} value
 * @param {(value: unknown) => string | undefined} swap
 * @returns {unknown}
 */
function replace(value, swap) {
  const swapped = swap(value);
  if (swapped !== undefined) return swapped;
  if (Array.isArray(value)) return value.map((child) => replace(child, swap));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child, swap)]));
  return value;
}

/** `2026-11-19T01:00Z`, with seconds only when they are not zero. */
export function isoMinute(/** @type {number} */ ms) {
  const iso = new Date(ms).toISOString();
  return iso.slice(17, 19) === "00" ? `${iso.slice(0, 16)}Z` : `${iso.slice(0, 19)}Z`;
}

/** The zone's offset at an instant, as `+05:00`. */
export function offset(/** @type {number} */ ms, /** @type {string} */ tz) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(ms)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "+00:00" : name.slice(3);
}

/** Wall-clock parts of an instant in a zone. */
function wall(/** @type {number} */ ms, /** @type {string} */ tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, month_day: `${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}`, seconds: parts.second };
}

/** `14:45+05:00` for an anchor's local time, with the date when `withDate`. */
export function localAnchor(/** @type {number} */ ms, /** @type {string} */ tz, withDate = false) {
  const parts = wall(ms, tz);
  const clock = parts.seconds === "00" ? parts.clock : `${parts.clock}:${parts.seconds}`;
  return `${withDate ? `${parts.date}T` : ""}${clock}${offset(ms, tz)}`;
}

/** Local `14:52` inside a one-day view, `11-18 14:52` across days. */
export function localWhen(/** @type {number} */ ms, /** @type {string} */ tz, acrossDays = false) {
  const parts = wall(ms, tz);
  return acrossDays ? `${parts.month_day} ${parts.clock}` : parts.clock;
}

/** The local date of an instant, `2026-11-18`. */
export const localDate = (/** @type {number} */ ms, /** @type {string} */ tz) => wall(ms, tz).date;

/** UTC instant of local midnight on `date` in `tz`. */
export function localMidnight(/** @type {string} */ date, /** @type {string} */ tz) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const shift = (/** @type {number} */ ms) => {
    const [sign, hours, minutes] = /^([+-])(\d\d):(\d\d)$/u.exec(offset(ms, tz))?.slice(1) ?? ["+", "00", "00"];
    return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
  };
  const first = guess - shift(guess);
  return guess - shift(first);
}

/** `+07:10` from the anchor; minutes keep counting past an hour (`+60:00`, `+105:00`). Only Episode detail uses relative times. */
export function relative(/** @type {number} */ ms, /** @type {number} */ anchor) {
  const total = Math.round((ms - anchor) / 1000);
  const sign = total < 0 ? "-" : "+";
  const abs = Math.abs(total);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** @param {Window} window @param {(ms: number) => string} at */
export const span = (window, at) => (window.from_ms === window.to_ms ? at(window.from_ms) : `${at(window.from_ms)}..${at(window.to_ms)}`);

/** A party: a seat handle with its name, or `all` for an item-wide subject. @typedef {{ ref: Ref, name: string | null } | "all"} Party */

/** @param {Party} party @param {(ref: Ref) => string} handle */
export function partyText(party, handle) {
  if (party === "all") return "all";
  const name = party.name === null ? "" : /^[\p{L}\p{N}_.-]+$/u.test(party.name) ? `(${party.name})` : `(${JSON.stringify(party.name)})`;
  return `${handle(party.ref)}${name}`;
}

/**
 * One reason a source does not prove a window complete, in words.
 * @param {Uncovered} entry
 * @param {(ms: number) => string} at
 */
export function uncoveredText(entry, at) {
  if (entry.why === "independence") return `${entry.fact} needs ${entry.needed} independent witnesses, has ${entry.found}`;
  if (entry.why === "not_read") return `${entry.source} not read`;
  if (entry.why === "not_emitted") return `${entry.fact} not emitted by ${entry.build}`;
  if (entry.why === "behind") return `${entry.source} read only to ${at(entry.complete_to_ms)}`;
  const tail = entry.gap.to_ms === null ? "tail unknown" : at(entry.gap.to_ms);
  return `${entry.source} evidence_gap ${at(entry.gap.from_ms)}..${tail} (${entry.gap.reason})`;
}

/** The area of a symptom code (`board` for `board.view_jumped`), which names a partial coverage compactly. */
export const area = (/** @type {string} */ code) => code.split(".")[0];
