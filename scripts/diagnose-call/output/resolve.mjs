// @ts-check
/**
 * Lookup: any handle, raw id, session alias, tenant or person name to the things it can mean. It never picks silently: a query that
 * matches more than one thing returns every candidate, and the caller shows them.
 *
 * A session id has three meanings in Chalk (an Episode id, an SDK client session `cs_`, a media provider's session id), so a raw id
 * is matched against all of them and each candidate says which meaning matched.
 */
import { formatHandle, parseHandle } from "./handle.mjs";
import { localWhen } from "./format.mjs";
import { refKind } from "./views.mjs";

/** @typedef {import("../proof/fixture-world.mjs").World} World */
/** @typedef {import("../proof/check.mjs").Item} Item */
/** @typedef {import("../proof/verdict.mjs").Verdict} Verdict */
/** @typedef {import("./views.mjs").Candidate} Candidate */

/**
 * What a candidate opens.
 * @typedef {{ kind: "item", item: Item }
 *   | { kind: "finding", item: Item, finding: string }
 *   | { kind: "person", person: { kind: "user" | "agent", id: string } | { kind: "seat", item: Item, participant: string }, tenant: string }
 *   | { kind: "tenant", tenant: string }} Target
 * `name` is what a name query matches: a tenant's, a person's or a guest seat's name.
 * @typedef {Candidate & { target: Target, tenant_id: string, name: string | null }} Entry
 */

/**
 * @param {World} world
 * @param {readonly Item[]} items
 * @param {readonly { item: Item, verdict: Verdict | null }[]} verdicts the stored verdict of each item, for finding handles
 * @returns {Entry[]}
 */
export function indexWorld(world, items, verdicts) {
  const tenantOf = (/** @type {string} */ id) => world.tenants.find((tenant) => tenant.id === id);
  const tenantName = (/** @type {string} */ id) => tenantOf(id)?.name ?? id;
  /** @type {Entry[]} */
  const entries = [];
  for (const tenant of world.tenants) entries.push({ kind: "tenant", id: tenant.id, label: tenant.name, tenant: null, meaning: null, when_ms: null, target: { kind: "tenant", tenant: tenant.id }, tenant_id: tenant.id, name: tenant.name });
  for (const person of world.people)
    entries.push({ kind: person.kind, id: person.id, label: person.name, tenant: tenantName(person.tenant), meaning: null, when_ms: null, target: { kind: "person", person: { kind: person.kind, id: person.id }, tenant: person.tenant }, tenant_id: person.tenant, name: person.name });
  for (const item of items) entries.push(...itemEntries(item, tenantName(item.tenant), tenantOf(item.tenant)?.tz ?? "UTC"));
  for (const session of world.sessions) {
    const item = items.find((candidate) => candidate.id === session.episode);
    if (!item) continue;
    entries.push({
      kind: session.meaning === "client_session" ? "client_session" : "media_connection",
      id: session.id,
      label: `session of ${formatHandle("participant", session.participant).slice(0, 7)}`,
      tenant: tenantName(item.tenant),
      meaning: session.meaning,
      when_ms: item.declaration.window.from_ms,
      target: { kind: "item", item },
      tenant_id: item.tenant,
      name: null,
    });
  }
  for (const { item, verdict } of verdicts) {
    for (const finding of verdict?.findings ?? []) entries.push({ kind: "finding", id: finding.id, label: finding.code, tenant: tenantName(item.tenant), meaning: null, when_ms: finding.window.from_ms, target: { kind: "finding", item, finding: finding.id }, tenant_id: item.tenant, name: null });
  }
  for (const item of items) {
    for (const o of world.evidence[item.id]?.observations ?? []) entries.push({ kind: "evidence", id: o.id, label: o.fact, tenant: tenantName(item.tenant), meaning: null, when_ms: o.window.from_ms, target: { kind: "item", item }, tenant_id: item.tenant, name: null });
  }
  return entries;
}

/**
 * The item itself and, for an Episode, each seat: a guest's seat is the only handle a guest has, so it targets the seat.
 * @param {Item} item
 * @param {string} tenant the tenant's name
 * @param {string} tz
 * @returns {Entry[]}
 */
function itemEntries(item, tenant, tz) {
  const declaration = item.declaration;
  const when_ms = declaration.window.from_ms;
  /** @type {Entry[]} */
  const entries = [{ kind: refKind(item.kind), id: item.id, label: localWhen(when_ms, tz, true), tenant, meaning: item.kind === "episode" ? "episode" : null, when_ms, target: { kind: "item", item }, tenant_id: item.tenant, name: null }];
  if (declaration.kind !== "episode") return entries;
  for (const seat of declaration.seats) {
    const person = seat.person;
    const guest = person.kind === "guest";
    /** @type {Target} */
    const target = { kind: "person", person: person.kind === "guest" ? { kind: "seat", item, participant: seat.participant } : { kind: person.kind, id: person.id }, tenant: item.tenant };
    entries.push({ kind: "participant", id: seat.participant, label: `${seat.name ?? "unnamed"} ${seat.role} in ${formatHandle("episode", item.id).slice(0, 7)}`, tenant, meaning: guest ? "guest" : null, when_ms, target, tenant_id: item.tenant, name: guest ? seat.name : null });
  }
  return entries;
}

const compact = (/** @type {string} */ id) => id.toLowerCase().replaceAll("-", "");
const HEX = /^[0-9a-f-]{4,}$/iu;

/**
 * Every entry the query can mean. `kinds` narrows the lookup for a typed command (`episode ep_9f` looks at Episodes only).
 * @param {readonly Entry[]} entries
 * @param {string} query
 * @param {{ tenant?: string | null, kinds?: readonly string[] | null }} [options] `tenant` is a tenant id
 * @returns {Entry[]}
 */
export function resolve(entries, query, { tenant = null, kinds = null } = {}) {
  const text = query.trim();
  const inScope = entries.filter((entry) => (tenant === null || entry.tenant_id === tenant) && (kinds === null || kinds.includes(entry.kind)));
  const parsed = parseHandle(text);
  /** @type {Entry[]} */
  let found;
  if (parsed) found = inScope.filter((entry) => entry.kind === parsed.kind && compact(entry.id).startsWith(parsed.fragment));
  else if (HEX.test(text) && compact(text).length >= 4) found = inScope.filter((entry) => entry.kind !== "tenant" && compact(entry.id).startsWith(compact(text)));
  else {
    const name = text.toLowerCase();
    found = inScope.filter((entry) => {
      const candidate = entry.name?.toLowerCase();
      return candidate !== undefined && (candidate === name || candidate.startsWith(`${name} `));
    });
  }
  const seen = new Set();
  return found.filter((entry) => {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
