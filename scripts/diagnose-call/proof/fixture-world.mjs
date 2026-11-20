// @ts-check
/**
 * The reference adapters: `check`'s four ports and the lookup index, over one in-memory world. Tests and `diagnose --fixture` use
 * them, and they are the contract a slice's live adapters (Postgres, Axiom, R2) implement. A world is plain data, so a fixture file
 * is a module that exports one.
 *
 * Stored verdicts in a world come from `history`: the evidence an earlier check saw. The world judges that evidence once when it
 * loads, so a stored verdict is always one the current code could have written, and a stale one is stale for a real reason.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonical } from "./bundle.mjs";
import { declarationDigest, judgeItem } from "./check.mjs";

/** @typedef {import("./check.mjs").Item} Item */
/** @typedef {import("./check.mjs").Ports} Ports */
/** @typedef {import("./check.mjs").Scope} Scope */
/** @typedef {import("./check.mjs").Stored} Stored */
/** @typedef {import("./profile.mjs").Declaration} Declaration */
/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */

/**
 * @typedef {{ id: string, name: string, tz: string }} Tenant
 * @typedef {{ kind: "user" | "agent", id: string, name: string, tenant: string }} Person
 * @typedef {{ id: string, meaning: "client_session" | "provider_media", episode: string, participant: string }} SessionAlias
 * @typedef {{ observations: Observation[], watermarks: Watermark[] }} Evidence
 * @typedef {{ item: string, asof_ms: number, evidence: Evidence }} History
 * @typedef {{
 *   asof_ms: number,
 *   tenants: Tenant[],
 *   people: Person[],
 *   declarations: Declaration[],
 *   sessions: SessionAlias[],
 *   evidence: Record<string, Evidence>,
 *   history: History[],
 * }} World
 */

/** @param {Evidence} evidence */
const fingerprintOf = (evidence) => createHash("sha256").update(canonical(evidence)).digest("hex").slice(0, 16);

/**
 * @param {World} world
 * @param {{ catalogue: readonly CheckDef[], rules: string, store?: string | null }} options `store` is a JSON file that keeps verdicts across runs
 * @returns {Promise<{ world: World, items: Item[], ports: Ports }>}
 */
export async function openWorld(world, { catalogue, rules, store = null }) {
  const items = world.declarations.map((declaration) => ({ kind: declaration.kind, id: declaration.id, tenant: declaration.tenant, declaration }));
  const evidenceOf = (/** @type {Item} */ item) => world.evidence[item.id] ?? { observations: [], watermarks: [] };
  /** @type {Map<string, Stored>} */
  const stored = new Map();
  const key = (/** @type {{ kind: string, id: string }} */ item) => `${item.kind}:${item.id}`;
  const persist = () => {
    if (store !== null) writeFileSync(store, `${JSON.stringify([...stored.values()], null, 1)}\n`);
  };

  /** @type {Ports} */
  const ports = {
    population: {
      async items(scope) {
        if ("item" in scope) return items.filter((item) => item.kind === scope.item.kind && item.id === scope.item.id);
        return items.filter((item) => (scope.tenant === null || item.tenant === scope.tenant) && item.declaration.window.from_ms < scope.to_ms && (item.declaration.window.to_ms ?? Infinity) >= scope.from_ms);
      },
    },
    evidence: {
      async fingerprint(item) {
        return fingerprintOf(evidenceOf(item));
      },
      async read(item) {
        return structuredClone(evidenceOf(item));
      },
    },
    store: {
      async get(item) {
        return stored.get(key(item)) ?? null;
      },
      async put(entry) {
        stored.set(key(entry.item), entry);
        persist();
      },
    },
  };

  if (store !== null && existsSync(store)) {
    for (const entry of JSON.parse(readFileSync(store, "utf8"))) stored.set(key(entry.item), entry);
    return { world, items, ports };
  }
  for (const past of world.history) {
    const item = items.find((candidate) => candidate.id === past.item);
    if (!item) throw new TypeError(`history names ${past.item}, which the world does not declare`);
    const frozen = { ...ports, evidence: { fingerprint: async () => fingerprintOf(past.evidence), read: async () => structuredClone(past.evidence) } };
    const verdict = await judgeItem(item, frozen, { catalogue, rules, asof_ms: past.asof_ms, prior: null });
    stored.set(key(item), { item: { kind: item.kind, id: item.id }, declaration: declarationDigest(item.declaration), fingerprint: fingerprintOf(past.evidence), verdict });
  }
  persist();
  return { world, items, ports };
}
