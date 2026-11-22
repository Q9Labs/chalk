// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * The ProofBundle: the sealed set of observations and watermarks one verdict is built from. A bundle is opened on a profile that was
 * chosen before any evidence was read, filled, then sealed: sealing binds every observation to a subject of the profile, freezes the
 * set and gives it a digest. Only `judge` reads a bundle, and only a sealed one, so `healthy` can never be built from loose rows.
 */
import { createHash } from "node:crypto";
import { observation as checkObservation, watermark as checkWatermark } from "./evidence.mjs";
import { factDef } from "./facts.mjs";
import { ITEM, deepFreeze, seatKey, sessionKey } from "./profile.mjs";

/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./profile.mjs").Profile} Profile */
/** @typedef {import("./profile.mjs").Declaration} Declaration */

/**
 * @typedef {Readonly<Observation> & { readonly bound: string }} BoundObservation `bound` is the subject key: `*`, `pt:<id>` or `cs:<id>`.
 * @typedef {{ evidence: string, fact: string, why: string }} Unbound an observation whose identity does not match the authority
 * @typedef {{
 *   profile: Profile,
 *   observations: readonly BoundObservation[],
 *   unbound: readonly Unbound[],
 *   watermarks: readonly Readonly<Watermark>[],
 *   digest: string,
 *   asof_ms: number,
 * }} SealedBundle
 * Everything reachable from a sealed bundle is frozen, and `watermarks` is a frozen list in key order: a Map would stay writable
 * through `set` after `Object.freeze`, so a sealed bundle could gain evidence its digest never saw. `watermarkOf` looks one up.
 */

/** Each sealed bundle's watermarks by key, kept outside the bundle so nothing reachable from it can change. */
const SEALED = new WeakMap();

/** @param {unknown} bundle @returns {bundle is SealedBundle} */
export const isSealed = (bundle) => typeof bundle === "object" && bundle !== null && SEALED.has(bundle);

/** @param {string} source @param {string} subject */
export const watermarkKey = (source, subject) => `${source}|${subject}`;

/**
 * The watermark a sealed bundle holds for one source and subject.
 * @param {SealedBundle} bundle
 * @param {string} source
 * @param {string} subject
 * @returns {Readonly<Watermark> | undefined}
 */
export function watermarkOf(bundle, source, subject) {
  const index = SEALED.get(bundle);
  if (index === undefined) throw new TypeError("watermarkOf needs a sealed ProofBundle");
  return index.get(watermarkKey(source, subject));
}

/**
 * An observation is one row's claim about one fact, so a row that witnesses two facts is two observations under one event id. Two
 * observations are duplicates only when they share both.
 * @param {Readonly<Observation>} o
 */
const observationKey = (o) => `${o.id}|${o.fact}`;

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
  const { kept, unbound } = deduplicate(raw);
  /** @type {BoundObservation[]} */
  const observations = [];
  for (const o of kept) {
    const binding = bind(profile.declaration, o);
    if ("why" in binding) unbound.push({ evidence: o.id, fact: o.fact, why: binding.why });
    else observations.push(Object.freeze({ ...o, bound: binding.key }));
  }
  const index = indexWatermarks(profile.declaration, rawWatermarks);
  const watermarks = [...index.keys()].sort().map((key) => /** @type {Readonly<Watermark>} */ (index.get(key)));
  unbound.sort(byKey((entry) => `${entry.evidence}|${entry.fact}`));
  const digest = createHash("sha256")
    .update(canonical({ item: [profile.declaration.kind, profile.declaration.id], asof_ms, observations: kept, watermarks }))
    .digest("hex");
  const bundle = deepFreeze({ profile, observations, unbound, watermarks, digest, asof_ms });
  SEALED.set(bundle, index);
  return bundle;
}

/**
 * Keeps one observation per (event id, fact). Two that share both but differ are two rows claiming one id, so neither is kept.
 * @param {readonly Readonly<Observation>[]} raw
 */
function deduplicate(raw) {
  /** @type {Map<string, Readonly<Observation>>} */
  const kept = new Map();
  /** @type {Set<string>} */
  const conflicting = new Set();
  /** @type {Unbound[]} */
  const unbound = [];
  for (const o of [...raw].sort(byKey(observationKey))) {
    const key = observationKey(o);
    const seen = kept.get(key);
    if (seen === undefined) kept.set(key, o);
    else if (canonical(seen) !== canonical(o)) {
      conflicting.add(key);
      unbound.push({ evidence: o.id, fact: o.fact, why: "two different rows share this event id" });
    }
  }
  return { kept: [...kept.values()].filter((o) => !conflicting.has(observationKey(o))), unbound };
}

/**
 * One watermark per source and subject. A client session key belongs to an attempt, and only to the attempt it names.
 * @param {Readonly<Declaration>} declaration
 * @param {readonly Readonly<Watermark>[]} rawWatermarks
 */
function indexWatermarks(declaration, rawWatermarks) {
  /** @type {Map<string, Readonly<Watermark>>} */
  const index = new Map();
  for (const w of rawWatermarks) {
    const key = watermarkKey(w.source, w.subject);
    if (index.has(key)) throw new TypeError(`two watermarks for ${key}: fold a source's watermarks into one before adding it`);
    if (w.subject.startsWith("cs:") && w.subject !== sessionKey(declaration.id)) throw new TypeError(`watermark ${key} names another attempt: a client session key belongs to the attempt it names`);
    if (w.subject.startsWith("cs:") && declaration.kind !== "attempt") throw new TypeError(`watermark ${key}: a client session key belongs to an attempt, not a ${declaration.kind}`);
    index.set(key, w);
  }
  return index;
}

/** The subject field that names each non-Episode item, and how a row naming another one reads. */
const ITEM_FIELDS = Object.freeze({
  attempt: { field: /** @type {const} */ ("attempt"), other: "another attempt" },
  job: { field: /** @type {const} */ ("job"), other: "another job" },
  space: { field: /** @type {const} */ ("space"), other: "another Space" },
  tenant: { field: /** @type {const} */ ("tenant"), other: "another Tenant" },
  platform: { field: /** @type {const} */ ("environment"), other: "another environment" },
});

/**
 * Binds an observation to a subject of the profile by the authority's identity: the tenant first, then the item, and on an Episode
 * the seat, its admission generations and its media connections. A row of another tenant, or of none, binds to nothing, however its
 * other ids match, because ids are only unique inside a tenant. A row that names a seat the authority does not know, a generation
 * the seat never had, or another seat's connection is unbound: it counts for nobody, and the coverage says so. So is a row of a seat
 * fact that names no seat at all.
 * @param {Readonly<Declaration>} declaration
 * @param {Readonly<Observation>} o
 * @returns {{ key: string } | { why: string }}
 */
function bind(declaration, o) {
  const subject = o.subject;
  if (declaration.tenant !== null && subject.tenant !== declaration.tenant) return { why: subject.tenant === undefined ? "names no Tenant" : "names another Tenant" };
  if (declaration.kind !== "episode") {
    const { field, other } = ITEM_FIELDS[declaration.kind];
    return subject[field] === declaration.id ? { key: ITEM } : { why: `names ${other}` };
  }
  if (subject.episode !== declaration.id) return { why: subject.episode === undefined ? "names no Episode" : "names another Episode" };
  if (subject.participant !== undefined) return bindSeat(declaration, subject);
  if (subject.connection !== undefined) {
    const seats = declaration.seats.filter((candidate) => candidate.connections.includes(subject.connection ?? ""));
    return seats.length === 1 ? { key: seatKey(seats[0].participant) } : { why: "names a connection no seat holds" };
  }
  if (factDef(o.fact).per === "seat") return { why: "names no Participant or connection, and this fact is about one seat" };
  return { key: ITEM };
}

/**
 * @param {Readonly<import("./profile.mjs").EpisodeDeclaration>} declaration
 * @param {Readonly<import("./evidence.mjs").Subject>} subject
 * @returns {{ key: string } | { why: string }}
 */
function bindSeat(declaration, subject) {
  const seat = declaration.seats.find((candidate) => candidate.participant === subject.participant);
  if (!seat) return { why: "names a Participant the Episode has no seat for" };
  if (subject.generation !== undefined && !seat.generations.includes(subject.generation)) return { why: `names generation ${subject.generation}, which the seat never had` };
  if (subject.connection !== undefined && !seat.connections.includes(subject.connection)) return { why: "names a connection that belongs to another seat" };
  return { key: seatKey(seat.participant) };
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
