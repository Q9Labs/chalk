import { State } from "alchemy/State";
import { encodeState } from "alchemy/State/StateEncoding";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";

export const seedResource = <P extends object, A extends object>(resourceType: string, logicalId: string, instanceId: string, props: P, attr: A, downstream: string[], removalPolicy: "retain" | "destroy" = "destroy"): CreatedResourceState => ({
  status: "created",
  resourceType,
  logicalId,
  fqn: logicalId,
  instanceId,
  namespace: undefined,
  providerVersion: 0,
  props: { ...props },
  attr: { ...attr },
  bindings: [],
  downstream,
  removalPolicy,
});

export type Seed = { readonly rows: readonly CreatedResourceState[]; readonly output: unknown };

const sameState = (left: unknown, right: unknown) => JSON.stringify(encodeState(left)) === JSON.stringify(encodeState(right));

// A seeded stack holds the same records and output its first deploy would write, so
// the deploy gate sees a cut-over stack and the first plan compares against live.
// Rerunning the seed is idempotent; it refuses to touch state a deploy has since changed.
export const writeSeed = Effect.fn(function* (identity: { readonly stack: string; readonly stage: string }, seed: Seed) {
  const store = yield* yield* State;
  const existing = yield* store.list(identity);
  if (existing.some((fqn) => !seed.rows.some((entry) => entry.fqn === fqn))) return yield* Effect.die("Destination contains unexpected resources; refusing to seed.");
  for (const entry of seed.rows) {
    const old = yield* store.get({ ...identity, fqn: entry.fqn });
    if (old && (!("resourceType" in old) || old.resourceType !== entry.resourceType || old.instanceId !== entry.instanceId || old.status !== "created")) {
      return yield* Effect.die(`Destination ${entry.fqn} is not this migration's completed resource; refusing to overwrite.`);
    }
  }
  const output = yield* store.getOutput(identity);
  if (output !== undefined && !sameState(output, seed.output)) return yield* Effect.die("Destination output differs from the seed; a deploy has changed it, so refusing to reseed.");
  for (const entry of seed.rows) {
    if (!(yield* store.get({ ...identity, fqn: entry.fqn }))) yield* store.set({ ...identity, fqn: entry.fqn, value: entry });
    yield* Effect.logInfo(`Seeded or already present: ${identity.stack}/${identity.stage}/${entry.fqn}`);
  }
  if (output === undefined) yield* store.setOutput({ ...identity, value: seed.output });
  yield* Effect.logInfo(`Seeded or already present: ${identity.stack}/${identity.stage} output`);
});
