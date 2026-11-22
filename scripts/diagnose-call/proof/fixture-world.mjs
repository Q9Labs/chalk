// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * The reference adapters: `check`'s four ports and the lookup index, over one in-memory world. Tests and `diagnose --fixture` use
 * them, and they are the contract a slice's live adapters (Postgres, Axiom, R2) implement. A world is plain data, so a fixture file
 * is a module that exports one.
 *
 * Stored verdicts in a world come from `history`: the evidence an earlier check saw. The world judges that evidence once when it
 * loads, so a stored verdict is always one the current code could have written, and a stale one is stale for a real reason.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonical } from "./bundle.mjs";
import { declarationDigest, judgeSnapshot } from "./check.mjs";

/** @typedef {import("./check.mjs").Item} Item */
/** @typedef {import("./check.mjs").Ports} Ports */
/** @typedef {import("./check.mjs").Scope} Scope */
/** @typedef {import("./check.mjs").Stored} Stored */
/** @typedef {import("./check.mjs").Entry} Entry */
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

const LOCK_WAIT_MS = 5000;

/**
 * Where verdicts live. Without a file they live in this process; with one, every read and every conditional write goes to the
 * file, and a write holds an exclusive lock file while it re-reads, compares and renames, so two processes sharing a store
 * can't lose each other's verdicts.
 * @typedef {{ read(): Map<string, Stored>, update(change: (entries: Map<string, Stored>) => boolean): Promise<boolean> }} VerdictFile
 * @param {string | null} path
 * @returns {VerdictFile}
 */
function verdictFile(path) {
  if (path === null) {
    /** @type {Map<string, Stored>} */
    const entries = new Map();
    return { read: () => entries, update: async (change) => change(entries) };
  }
  const file = path;
  const read = () => {
    /** @type {Map<string, Stored>} */
    const entries = new Map();
    if (!existsSync(file)) return entries;
    for (const entry of JSON.parse(readFileSync(file, "utf8"))) entries.set(keyOf(entry.item), { revision: 0, ...entry });
    return entries;
  };
  return {
    read,
    async update(change) {
      const release = await lock(`${file}.lock`);
      try {
        const entries = read();
        if (!change(entries)) return false;
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify([...entries.values()], null, 1)}\n`);
        renameSync(temp, file);
        return true;
      } finally {
        release();
      }
    },
  };
}

/** @param {string} path */
async function lock(path) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return () => unlinkSync(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() > deadline) throw new Error(`store lock ${path} is still held after ${LOCK_WAIT_MS} ms; remove it if no diagnose process is running`, { cause: error });
      await delay(10);
    }
  }
}

const keyOf = (/** @type {{ kind: string, id: string }} */ item) => `${item.kind}:${item.id}`;

/**
 * @param {World} world
 * @param {{ catalogue: readonly CheckDef[], rules: string, store?: string | null }} options `store` is a JSON file that keeps verdicts across runs
 * @returns {Promise<{ world: World, items: Item[], ports: Ports }>}
 */
export async function openWorld(world, { catalogue, rules, store = null }) {
  const items = world.declarations.map((declaration) => ({ kind: declaration.kind, id: declaration.id, tenant: declaration.tenant, declaration }));
  const evidenceOf = (/** @type {Item} */ item) => world.evidence[item.id] ?? { observations: [], watermarks: [] };
  const verdicts = verdictFile(store);

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
        const evidence = structuredClone(evidenceOf(item));
        return { ...evidence, fingerprint: fingerprintOf(evidence) };
      },
    },
    store: {
      async get(item) {
        return verdicts.read().get(keyOf(item)) ?? null;
      },
      put(entry, { expect }) {
        return verdicts.update((entries) => {
          const current = entries.get(keyOf(entry.item)) ?? null;
          if ((current?.revision ?? null) !== expect) return false;
          entries.set(keyOf(entry.item), { ...entry, revision: (current?.revision ?? 0) + 1 });
          return true;
        });
      },
    },
  };

  const seeded = world.history.map((past) => {
    const item = items.find((candidate) => candidate.id === past.item);
    if (!item) throw new TypeError(`history names ${past.item}, which the world does not declare`);
    const verdict = judgeSnapshot(item, structuredClone(past.evidence), { catalogue, rules, asof_ms: past.asof_ms, prior: null });
    return { item: { kind: item.kind, id: item.id }, declaration: declarationDigest(item.declaration), fingerprint: fingerprintOf(past.evidence), verdict, revision: 1 };
  });
  await verdicts.update((entries) => {
    if (store !== null && existsSync(store)) return false;
    for (const entry of seeded) entries.set(keyOf(entry.item), entry);
    return true;
  });
  return { world, items, ports };
}
