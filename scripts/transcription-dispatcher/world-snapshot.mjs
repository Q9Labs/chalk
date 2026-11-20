#!/usr/bin/env node
// @ts-check
/**
 * Freeze the live transcription world into a `diagnose --fixture` world module.
 *
 * `node scripts/transcription-dispatcher/world-snapshot.mjs --job <artifact job uuid> [--episode <episode uuid>] --out <file.mjs>`
 *
 * Each named item is read through scripts/transcription-dispatcher/evidence.mjs — the same db/log/r2 witnesses a live
 * `diagnose` would use — and the worlds are merged into one `export default <json>` module: no imports, nothing but data, so
 * the fixture can be checked in, diffed and replayed exactly.
 *
 * The output is deterministic for a fixed answer set: object keys are written in construction order and every id the reader
 * mints is content-derived, so two snapshots of the same stores differ only where the stores differed.
 */
import { writeFileSync } from "node:fs";
import { buildWorld } from "./evidence.mjs";

/** @typedef {import("../diagnose-call/proof/fixture-world.mjs").World} World */
/** @typedef {import("../diagnose-call/proof/profile.mjs").Declaration} Declaration */

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
};
const jobId = flag("--job");
const episodeId = flag("--episode");
const out = flag("--out");

if ((jobId === null && episodeId === null) || out === null) {
  console.error("usage: node scripts/transcription-dispatcher/world-snapshot.mjs --job <uuid> [--episode <uuid>] --out <file.mjs>");
  process.exit(64);
}

/** @type {{ kind: "job" | "episode", id: string }[]} */
const items = [];
if (jobId !== null) items.push({ kind: "job", id: jobId });
if (episodeId !== null) items.push({ kind: "episode", id: episodeId });

/** @type {World} */
const world = { asof_ms: 0, tenants: [], people: [], declarations: [], sessions: [], evidence: {}, history: [] };
const tenantIds = new Set();
const peopleIds = new Set();
const declarationIds = new Set();
/** @type {string[]} */
const notes = [];

for (const item of items) {
  const built = await buildWorld(item);
  notes.push(...built.notes);
  // The merged world is as of its least-covered instant: an open item is judged up to `asof_ms`, and a later stamp would
  // put every earlier item's sources behind it.
  world.asof_ms = world.asof_ms === 0 ? built.world.asof_ms : Math.min(world.asof_ms, built.world.asof_ms);
  for (const tenant of built.world.tenants) {
    if (tenantIds.has(tenant.id)) continue;
    tenantIds.add(tenant.id);
    world.tenants.push(tenant);
  }
  for (const person of built.world.people) {
    if (peopleIds.has(person.id)) continue;
    peopleIds.add(person.id);
    world.people.push(person);
  }
  for (const declaration of built.world.declarations) {
    const key = `${declaration.kind}:${declaration.id}`;
    if (declarationIds.has(key)) continue;
    declarationIds.add(key);
    world.declarations.push(/** @type {Declaration} */ (declaration));
  }
  // Evidence maps are keyed by item id, so two different items can never collide; a repeated id keeps the freshest read.
  Object.assign(world.evidence, built.world.evidence);
}

const observationCount = Object.values(world.evidence).reduce((count, evidence) => count + evidence.observations.length, 0);
writeFileSync(out, `export default ${JSON.stringify(world, null, 1)}\n`);
for (const note of notes) console.log(`note: ${note}`);
console.log(`wrote ${out}: ${world.declarations.map((declaration) => `${declaration.kind} ${declaration.id}`).join(", ")} — ${observationCount} observations`);
