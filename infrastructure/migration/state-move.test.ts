import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryService, type CreatedResourceState, type PersistedState, type ResourceState, type StateService } from "alchemy/State";
import * as Effect from "effect/Effect";
import { moveState, recorderRuntimeDownloadsInventory as inventory, type StateMove } from "./state-move.ts";

const move: StateMove = { from: { stack: "archive-cdn", stage: "nightly" }, to: { stack: "recorder-runtime-downloads", stage: "production" } };
const output = { distribution_url: "https://example.cloudfront.net", key_pair_id: "KEY" };
type Stages = Record<string, Record<string, Record<string, ResourceState>>>;

const created = (logicalId: string, resourceType: string): CreatedResourceState => ({
  status: "created",
  resourceType,
  logicalId,
  fqn: logicalId,
  namespace: undefined,
  instanceId: `${logicalId}-instance`,
  providerVersion: 0,
  props: { tags: { "chalk:environment": "nightly" } },
  attr: { id: `${logicalId}-id` },
  bindings: [],
  downstream: [],
  removalPolicy: "retain",
});
const seeded = () => Object.entries(inventory).map(([id, type]) => created(id, type));
const rowMap = (rows: readonly ResourceState[]) => Object.fromEntries(rows.map((row) => [row.fqn, row]));

interface World {
  readonly state: Stages;
  readonly outputs: Record<string, Record<string, unknown>>;
  readonly store: () => Promise<StateService>;
}
function world(sourceRows: readonly ResourceState[], destinationRows: readonly ResourceState[] = [], outputs: { source?: unknown; destination?: unknown } = { source: output }): World {
  const state: Stages = { [move.from.stack]: { [move.from.stage]: rowMap(sourceRows) }, [move.to.stack]: { [move.to.stage]: rowMap(destinationRows) } };
  const stored: Record<string, Record<string, unknown>> = {};
  if (outputs.source !== undefined) stored[move.from.stack] = { [move.from.stage]: outputs.source };
  if (outputs.destination !== undefined) stored[move.to.stack] = { [move.to.stage]: outputs.destination };
  return { state, outputs: stored, store: () => Effect.runPromise(InMemoryService(state, stored)) };
}
const stageRows = (w: World, id: { stack: string; stage: string }) => Object.values(w.state[id.stack]?.[id.stage] ?? {});
const outputOf = (w: World, id: { stack: string; stage: string }) => w.outputs[id.stack]?.[id.stage];

// The boundary a crash can hit: the k-th write to the state store dies before it lands.
function crashingAfter(store: StateService, budget: { left: number }): StateService {
  const guarded = <A, E>(effect: Effect.Effect<A, E>) => Effect.suspend(() => (budget.left-- <= 0 ? Effect.die("injected crash") : effect));
  return {
    ...store,
    set: <V extends PersistedState>(request: { stack: string; stage: string; fqn: string; value: V }) => guarded(store.set(request)),
    setOutput: (request) => guarded(store.setOutput(request)),
    delete: (request) => guarded(store.delete(request)),
    deleteStack: (request) => guarded(store.deleteStack(request)),
  };
}
const run = async (w: World, dryRun = false) => Effect.runPromise(moveState(await w.store(), move, inventory, dryRun));
const fails = async (w: World, pattern: RegExp) => assert.rejects(run(w), pattern);
const snapshot = (w: World) => JSON.stringify([w.state, w.outputs]);

test("moves every record and the output to the production identity, then removes the old state", async () => {
  const w = world(seeded());
  const original = seeded();
  const report = await run(w);
  assert.deepEqual([...report.copied].sort(), Object.keys(inventory).sort());
  assert.equal(report.outputCopied, true);
  assert.deepEqual(stageRows(w, move.to), original);
  assert.equal(outputOf(w, move.to) !== undefined && JSON.stringify(outputOf(w, move.to)), JSON.stringify(output));
  assert.equal(stageRows(w, move.from).length, 0);
  assert.equal(outputOf(w, move.from), undefined);
});

test("dry run reports the move and writes nothing", async () => {
  const w = world(seeded());
  const before = snapshot(w);
  const report = await run(w, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.copied.length, 5);
  assert.equal(report.removed.length, 5);
  assert.equal(snapshot(w), before);
});

test("moving twice changes nothing the second time", async () => {
  const w = world(seeded());
  await run(w);
  const after = snapshot(w);
  const again = await run(w);
  assert.deepEqual(again.copied, []);
  assert.deepEqual(again.removed, []);
  assert.equal(snapshot(w), after);
});

test("a crash before any write of the move, then a retry, ends in the finished state", async () => {
  const reference = world(seeded());
  await run(reference);
  const writes = 5 + 1 + 5 + 1; // copies, output, removals, stage delete
  for (let crashAt = 0; crashAt < writes; crashAt++) {
    const w = world(seeded());
    const crashing = crashingAfter(await w.store(), { left: crashAt });
    await assert.rejects(Effect.runPromise(moveState(crashing, move, inventory, false)), /injected crash/);
    await run(w);
    assert.deepEqual(stageRows(w, move.to), stageRows(reference, move.to), `crash at write ${crashAt}`);
    assert.equal(stageRows(w, move.from).length, 0, `crash at write ${crashAt}`);
    assert.equal(outputOf(w, move.from), undefined, `crash at write ${crashAt}`);
    assert.equal(JSON.stringify(outputOf(w, move.to)), JSON.stringify(output), `crash at write ${crashAt}`);
  }
});

test("a move without a stored output moves the records only", async () => {
  const w = world(seeded(), [], {});
  const report = await run(w);
  assert.equal(report.outputCopied, false);
  assert.equal(stageRows(w, move.to).length, 5);
  assert.equal(outputOf(w, move.to), undefined);
});

const different = (): ResourceState => ({ ...created("Archive", inventory.Archive ?? ""), props: { tags: { "chalk:environment": "production" } } });
const refusals: ReadonlyArray<readonly [string, () => World, RegExp]> = [
  ["a destination that holds a different record", () => world(seeded(), [different()]), /different record for Archive/],
  ["a destination with a record outside the inventory", () => world(seeded(), [created("Surprise", "AWS.S3.Bucket")]), /not a completed resource of the expected inventory/],
  ["a source with a record outside the inventory", () => world([...seeded(), created("Surprise", "AWS.S3.Bucket")]), /not a completed resource of the expected inventory/],
  ["a source record of another type", () => world(seeded().map((row) => (row.logicalId === "Archive" ? { ...row, resourceType: "AWS.S3.Bucket" } : row))), /not a completed resource/],
  [
    "a source record that is not completed",
    () => world(seeded().map((row): ResourceState => (row.logicalId === "Archive" ? { status: "creating", resourceType: row.resourceType, logicalId: row.logicalId, fqn: row.fqn, namespace: undefined, instanceId: row.instanceId, providerVersion: 0, props: {}, bindings: [], downstream: [] } : row))),
    /not a completed resource/,
  ],
  ["a partial source with an empty destination", () => world(seeded().slice(0, 4)), /neither archive-cdn\/nightly nor recorder-runtime-downloads\/production/],
  ["a destination with a different output", () => world(seeded(), [], { source: output, destination: { distribution_url: "https://other.example.net" } }), /different stack output/],
  ["two empty identities", () => world([]), /nothing to move/],
];
for (const [label, build, message] of refusals)
  test(`refuses ${label} and writes nothing`, async () => {
    const w = build();
    const before = snapshot(w);
    await fails(w, message);
    assert.equal(snapshot(w), before);
  });
