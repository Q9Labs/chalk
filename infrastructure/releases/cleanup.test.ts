import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import { clearStage } from "./cleanup.ts";

interface RunResource extends Resource<"Test.RunResource", { name: string }, { name: string }> {}
const RunResource = Resource<RunResource>("Test.RunResource");
test("run-owned resources and state are destroyed; retry is idempotent and never evaluates declarations", async () => {
  let live: { name: string } | undefined;
  let deletions = 0,
    evaluations = 0;
  const providers = Provider.succeed(RunResource, {
    read: () => Effect.succeed(live),
    reconcile: ({ news }) =>
      Effect.sync(() => {
        live = news;
        return news;
      }),
    delete: () =>
      Effect.sync(() => {
        live = undefined;
        deletions++;
      }),
  });
  const state = inMemoryState();
  const stack = Alchemy.Stack(
    "proof",
    { providers, state },
    Effect.gen(function* () {
      evaluations++;
      yield* RunResource("Runtime", { name: "nightly-test" });
      return { ready: true };
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const create = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "deploy" });
      yield* Alchemist.apply(create);
      assert.ok(live);
      for (let attempt = 0; attempt < 2; attempt++) {
        const destroy = yield* Alchemist.plan({ stack, stage: "nightly-test", operation: "destroy" });
        yield* clearStage(destroy);
        assert.equal(live, undefined);
      }
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
  assert.equal(evaluations, 1);
  assert.equal(deletions, 1);
});
