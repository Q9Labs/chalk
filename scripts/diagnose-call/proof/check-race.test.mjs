// @ts-check
// The judge's interleaving against the store port: check A reads no prior and pauses, check B stores a broken verdict, the rows are
// deleted, and A resumes. A proven broken finding must survive, so A's write is conditional on the prior it read.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CATALOGUE, RULES } from "./catalogue.mjs";
import { check } from "./check.mjs";
import { openWorld } from "./fixture-world.mjs";
import { ASOF, IDS, nov18 } from "../fixtures/nov18.mjs";

/** @typedef {import("./check.mjs").Ports} Ports */

const SCOPE = { item: { kind: /** @type {const} */ ("episode"), id: IDS.ep9feb } };
const options = { catalogue: CATALOGUE, rules: RULES, asof_ms: ASOF };

/** A world holding only the broken Episode, with no stored verdict yet. */
function brokenOnly() {
  const world = nov18();
  return { ...world, declarations: world.declarations.filter((declaration) => declaration.id === IDS.ep9feb), history: [] };
}

/**
 * Ports whose store read waits for `release` after it answers, the way a check paused between reading its prior and writing.
 * @param {Ports} ports
 * @param {Promise<void>} release
 * @returns {Ports}
 */
const pausedAfterGet = (ports, release) => ({
  ...ports,
  store: {
    ...ports.store,
    async get(item) {
      const stored = await ports.store.get(item);
      await release;
      return stored;
    },
  },
});

describe("check under concurrent writers", () => {
  it("keeps a broken finding that a concurrent check stored while another read no prior, then saw the rows deleted", async () => {
    const world = brokenOnly();
    const { ports } = await openWorld(world, { catalogue: CATALOGUE, rules: RULES });
    /** @type {() => void} */
    let resume = () => {};
    const release = new Promise((resolve) => {
      resume = () => resolve(undefined);
    });

    const a = check(SCOPE, pausedAfterGet(ports, release), options);
    const [b] = await check(SCOPE, ports, options);
    assert.equal(b.verdict.outcome, "broken", "check B proves the finding");
    const proven = b.verdict.findings.filter((finding) => finding.outcome === "broken").map((finding) => finding.id);

    world.evidence[IDS.ep9feb] = { ...world.evidence[IDS.ep9feb], observations: [] };
    resume();
    await a;

    const stored = await ports.store.get({ kind: "episode", id: IDS.ep9feb, tenant: IDS.tenant, declaration: world.declarations[0] });
    assert.equal(stored?.verdict.outcome, "broken", "the later write never replaces a proven broken verdict");
    for (const id of proven) {
      assert.ok(
        stored?.verdict.findings.some((finding) => finding.id === id),
        `finding ${id} survives`,
      );
    }
  });

  it("refuses a write whose expected prior is no longer the stored one", async () => {
    const { ports } = await openWorld(brokenOnly(), { catalogue: CATALOGUE, rules: RULES });
    const [first] = await check(SCOPE, ports, options);
    const item = { kind: /** @type {const} */ ("episode"), id: IDS.ep9feb };
    const entry = { item, declaration: "d", fingerprint: "f", verdict: first.verdict };
    assert.equal(await ports.store.put(entry, { expect: null }), false, "an item that has a verdict is not written as if it had none");
    const current = await ports.store.get({ ...item, tenant: IDS.tenant, declaration: brokenOnly().declarations[0] });
    assert.equal(await ports.store.put(entry, { expect: current?.revision ?? -1 }), true);
  });

  it("keeps a broken finding when two processes share one store file and the other reads after the rows are deleted", async () => {
    const store = join(mkdtempSync(join(tmpdir(), "diagnose-store-")), "store.json");
    const worldA = brokenOnly();
    const a = await openWorld(worldA, { catalogue: CATALOGUE, rules: RULES, store });
    const b = await openWorld(brokenOnly(), { catalogue: CATALOGUE, rules: RULES, store });

    const [rb] = await check(SCOPE, b.ports, options);
    assert.equal(rb.verdict.outcome, "broken", "process B proves the finding");
    worldA.evidence[IDS.ep9feb] = { ...worldA.evidence[IDS.ep9feb], observations: [] };
    await check(SCOPE, a.ports, options);

    const file = JSON.parse(readFileSync(store, "utf8"));
    assert.deepEqual(
      file.map((/** @type {{ verdict: { outcome: string } }} */ entry) => entry.verdict.outcome),
      ["broken"],
      "process A rechecks from B's broken verdict and keeps it",
    );
  });

  it("keeps both verdicts when two processes sharing one store file check different items", async () => {
    const store = join(mkdtempSync(join(tmpdir(), "diagnose-store-")), "store.json");
    const world = () => ({ ...nov18(), history: [] });
    const a = await openWorld(world(), { catalogue: CATALOGUE, rules: RULES, store });
    const b = await openWorld(world(), { catalogue: CATALOGUE, rules: RULES, store });
    const other = world().declarations.find((declaration) => declaration.kind === "episode" && declaration.id !== IDS.ep9feb);
    assert.ok(other);

    await check(SCOPE, b.ports, options);
    await check({ item: { kind: other.kind, id: other.id } }, a.ports, options);

    const file = JSON.parse(readFileSync(store, "utf8"));
    assert.deepEqual(file.map((/** @type {{ item: { id: string } }} */ entry) => entry.item.id).sort(), [IDS.ep9feb, other.id].sort(), "neither process's write drops the other's");
  });
});
