// @ts-check
/**
 * The ProofBundle: the sealed set of observations and watermarks one verdict is built from. A bundle is opened on a profile that was
 * chosen before any evidence was read, filled, then sealed: sealing binds every observation to a subject of the profile, freezes the
 * set and gives it a digest. Only `judge` reads a bundle, and only a sealed one, so `healthy` can never be built from loose rows.
 */
import { createHash } from "node:crypto";
import { observation as checkObservation, watermark as checkWatermark } from "./evidence.mjs";
import { factDef } from "./facts.mjs";
import { ITEM, deepFreeze, seatKey } from "./profile.mjs";

/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./profile.mjs").Profile} Profile */

/**
 * @typedef {Readonly<Observation> & { readonly bound: string }} BoundObservation `bound` is the subject key: `*` or `pt:<id>`.
 * @typedef {{ evidence: string, fact: string, why: string }} Unbound an observation whose identity does not match the authority
 * @typedef {{
 *   profile: Profile,
 *   observations: readonly BoundObservation[],
 *   unbound: readonly Unbound[],
 *   watermarks: ReadonlyMap<string, Readonly<Watermark>>,
 *   digest: string,
 *   asof_ms: number,
 * }} SealedBundle
 */

const SEALED = new WeakSet();

/** @param {unknown} bundle @returns {bundle is SealedBundle} */
export const isSealed = (bundle) => typeof bundle === "object" && bundle !== null && SEALED.has(bundle);

/** @param {string} source @param {string} subject */
export const watermarkKey = (source, subject) => `${source}|${subject}`;

/**
 * @param {Profile} profile
 * @param {{ asof_ms: number }} options
 */
export function openBundle(profile, { asof_ms }) {
  if (!Object.isFrozen(profile)) throw new TypeError("openBundle needs a profile from profileFor");
  /** @type {Readonly<Observation>[]} */
  const observations = [];
  /** @type {Readonly<Watermark>[]} */
  const watermarks = [];
  let sealed = false;
  const open = () => {
    if (sealed) throw new TypeError("the bundle is sealed: open a new one for new evidence");
  };
  return {
    /** @param {Observation} o */
    add(o) {
      open();
      observations.push(checkObservation(o));
    },
    /** @param {Watermark} w */
    watermark(w) {
      open();
      watermarks.push(checkWatermark(w));
    },
    /** @returns {SealedBundle} */
    seal() {
      open();
      sealed = true;
      return sealBundle(profile, observations, watermarks, asof_ms);
    },
  };
}

/**
 * @param {Profile} profile
 * @param {readonly Readonly<Observation>[]} raw
 * @param {readonly Readonly<Watermark>[]} rawWatermarks
 * @param {number} asof_ms
 * @returns {SealedBundle}
 */
function sealBundle(profile, raw, rawWatermarks, asof_ms) {
  /** @type {Map<string, Readonly<Observation>>} */
  const byId = new Map();
  /** @type {Unbound[]} */
  const unbound = [];
  for (const o of [...raw].sort(byKey((candidate) => candidate.id))) {
    const seen = byId.get(o.id);
    if (seen === undefined) byId.set(o.id, o);
    else if (canonical(seen) !== canonical(o)) unbound.push({ evidence: o.id, fact: o.fact, why: "two different rows share this event id" });
  }
  /** @type {BoundObservation[]} */
  const observations = [];
  for (const o of byId.values()) {
    if (unbound.some((entry) => entry.evidence === o.id)) continue;
    const binding = bind(profile, o);
    if ("why" in binding) unbound.push({ evidence: o.id, fact: o.fact, why: binding.why });
    else observations.push(Object.freeze({ ...o, bound: binding.key }));
  }
  /** @type {Map<string, Readonly<Watermark>>} */
  const watermarks = new Map();
  for (const w of rawWatermarks) {
    const key = watermarkKey(w.source, w.subject);
    if (watermarks.has(key)) throw new TypeError(`two watermarks for ${key}: fold a source's watermarks into one before adding it`);
    watermarks.set(key, w);
  }
  unbound.sort(byKey((entry) => entry.evidence));
  const digest = createHash("sha256")
    .update(canonical({ item: [profile.declaration.kind, profile.declaration.id], observations: [...byId.values()], watermarks: [...watermarks.keys()].sort().map((key) => watermarks.get(key)) }))
    .digest("hex");
  const bundle = { profile, observations: deepFreeze(observations), unbound: deepFreeze(unbound), watermarks, digest, asof_ms };
  Object.freeze(bundle);
  SEALED.add(bundle);
  return bundle;
}

/**
 * Binds an observation to a subject of the profile by the authority's identity: the Episode, the seat, its admission generations and
 * its media connections. A row that names a seat the authority does not know, a generation the seat never had, or another seat's
 * connection is unbound: it counts for nobody, and the coverage says so. So is a row of a seat fact that names no seat at all.
 * @param {Profile} profile
 * @param {Readonly<Observation>} o
 * @returns {{ key: string } | { why: string }}
 */
function bind(profile, o) {
  const declaration = profile.declaration;
  const subject = o.subject;
  if (declaration.kind === "attempt") return subject.attempt === declaration.id ? { key: ITEM } : { why: "names another attempt" };
  if (declaration.kind === "job") return subject.job === declaration.id ? { key: ITEM } : { why: "names another job" };
  if (declaration.kind === "space") return subject.space === declaration.id ? { key: ITEM } : { why: "names another Space" };
  if (declaration.kind === "tenant") return subject.tenant === declaration.id ? { key: ITEM } : { why: "names another Tenant" };
  if (declaration.kind === "platform") return subject.environment === declaration.id ? { key: ITEM } : { why: "names another environment" };
  if (subject.episode !== declaration.id) return { why: subject.episode === undefined ? "names no Episode" : "names another Episode" };
  if (subject.participant !== undefined) {
    const seat = declaration.seats.find((candidate) => candidate.participant === subject.participant);
    if (!seat) return { why: "names a Participant the Episode has no seat for" };
    if (subject.generation !== undefined && !seat.generations.includes(subject.generation)) return { why: `names generation ${subject.generation}, which the seat never had` };
    if (subject.connection !== undefined && !seat.connections.includes(subject.connection)) return { why: "names a connection that belongs to another seat" };
    return { key: seatKey(seat.participant) };
  }
  if (subject.connection !== undefined) {
    const seats = declaration.seats.filter((candidate) => candidate.connections.includes(subject.connection ?? ""));
    return seats.length === 1 ? { key: seatKey(seats[0].participant) } : { why: "names a connection no seat holds" };
  }
  if (factDef(o.fact).per === "seat") return { why: "names no Participant or connection, and this fact is about one seat" };
  return { key: ITEM };
}

/**
 * JSON with sorted keys, so equal content gives an equal digest.
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

/**
 * @template T
 * @param {(item: T) => string} key
 * @returns {(a: T, b: T) => number}
 */
export const byKey = (key) => (a, b) => {
  const left = key(a);
  const right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
};
