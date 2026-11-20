import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import type { ResourceState } from "alchemy/State/ResourceState";
import { encodeState } from "alchemy/State/StateEncoding";
import * as Effect from "effect/Effect";
import { requireSeededState } from "../releases/deploy.ts";
import { stackOutput } from "../sfu/config.ts";
import { seedResource, writeSeed } from "./resource.ts";

type NodeAttr = { name: string; ipv4: string; dropletId: number };
interface Node extends Resource<"Test.Seed.Node", { size: string }, NodeAttr> {}
const Node = Resource<Node>("Test.Seed.Node");
const live: NodeAttr = { name: "node", ipv4: "192.0.2.10", dropletId: 42 };
const identity = { stack: "seeded", stage: "production" };
const seed = { rows: [seedResource(Node.Type, "Node", "node", { size: "small" }, live, [])], output: stackOutput(live) };

// The stack returns its output through the same builder the seed uses, as the SFU entry does.
const deployment = (records: Record<string, Record<string, Record<string, ResourceState>>>, outputs: Record<string, Record<string, unknown>>) => {
  const providers = Provider.succeed(Node, {
    read: () => Effect.succeed(live),
    reconcile: () => Effect.die("A seeded stack must not change its live resource"),
    delete: () => Effect.die("A seeded stack must not delete its live resource"),
  });
  const stack = Alchemy.Stack(
    identity.stack,
    { providers, state: inMemoryState(records, outputs) },
    Effect.gen(function* () {
      const node = yield* Node("Node", { size: "small" });
      return Output.all(node.name, node.ipv4, node.dropletId).pipe(Output.map(([name, ipv4, dropletId]) => stackOutput({ name, ipv4, dropletId })));
    }),
  );
  return Effect.gen(function* () {
    const plan = yield* Alchemist.plan({ stack, stage: identity.stage, operation: "deploy" });
    yield* requireSeededState(plan);
    assert.deepEqual(
      Object.values(plan.native.resources).map((row) => row.action),
      ["noop"],
    );
    assert.equal(Object.keys(plan.native.deletions).length, 0);
    yield* Alchemist.apply(plan);
  }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped);
};

const seedInto = (records: Record<string, Record<string, Record<string, ResourceState>>>, outputs: Record<string, Record<string, unknown>>) => writeSeed(identity, seed).pipe(Effect.provide(inMemoryState(records, outputs)));

test("a seeded production stack passes the deploy gate, plans no change and keeps its output", async () => {
  const records = {};
  const outputs: Record<string, Record<string, unknown>> = {};
  await Effect.runPromise(seedInto(records, outputs));
  await Effect.runPromise(deployment(records, outputs));
  assert.deepEqual(encodeState(outputs[identity.stack]?.[identity.stage]), encodeState(seed.output));
  await Effect.runPromise(seedInto(records, outputs));
});

test("a stack seeded with records but no output is refused by the deploy gate", async () => {
  const records = { [identity.stack]: { [identity.stage]: { Node: seed.rows[0]! } } };
  await assert.rejects(Effect.runPromise(deployment(records, {})), /missing seeded production resources\/outputs/);
});

test("the seed refuses to reseed over an output a deploy has changed", async () => {
  const records = {};
  const outputs = { [identity.stack]: { [identity.stage]: stackOutput({ ...live, dropletId: 43 }) } };
  await assert.rejects(Effect.runPromise(seedInto(records, outputs)), /Destination output differs from the seed/);
  assert.deepEqual(records, {});
});
