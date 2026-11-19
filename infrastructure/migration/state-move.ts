import { isDeepStrictEqual } from "node:util";
import { isResourceState, type PersistedState, type StateService } from "alchemy/State";
import * as Effect from "effect/Effect";

// Moves one stage's state from its legacy identity to its own, so Alchemy owns it under the right
// name. The caller holds both leases: they come from one store, which takes each (stack, stage)
// lease on first use and keeps it until its scope closes. The order is copy, verify, then remove,
// and every step is a pure function of what both identities hold, so a retry after a crash at any
// point ends in the same state.
export interface StateIdentity {
  readonly stack: string;
  readonly stage: string;
}
export interface StateMove {
  readonly from: StateIdentity;
  readonly to: StateIdentity;
}
interface StateMoveReport {
  readonly dryRun: boolean;
  readonly copied: readonly string[];
  readonly removed: readonly string[];
  readonly outputCopied: boolean;
}

// The recorder runtime downloads stack: logical ID to resource type, as seeded from OpenTofu.
export const recorderRuntimeDownloadsInventory: Readonly<Record<string, string>> = {
  ArchiveAccess: "AWS.CloudFront.OriginAccessControl",
  ArchivePublicKey: "AWS.CloudFront.PublicKey",
  ArchiveKeyGroup: "AWS.CloudFront.KeyGroup",
  Archive: "AWS.CloudFront.Distribution",
  ArtifactsPolicy: "Chalk.S3.BucketPolicy",
};

const rowsOf = Effect.fn(function* (store: StateService, identity: StateIdentity, inventory: Readonly<Record<string, string>>) {
  const rows = new Map<string, PersistedState>();
  for (const fqn of yield* store.list(identity)) {
    const row = yield* store.get({ ...identity, fqn });
    if (!row) continue;
    const expected = Object.entries(inventory).find(([id]) => id === fqn)?.[1];
    if (!isResourceState(row) || row.fqn !== fqn || row.logicalId !== fqn || row.resourceType !== expected || row.status !== "created") {
      return yield* Effect.die(`${identity.stack}/${identity.stage} holds ${fqn}, which is not a completed resource of the expected inventory; refusing to move it`);
    }
    rows.set(fqn, row);
  }
  return rows;
});

// What both identities hold, validated: a record that exists on both sides must be identical.
const survey = Effect.fn(function* (store: StateService, { from, to }: StateMove, inventory: Readonly<Record<string, string>>) {
  const source = yield* rowsOf(store, from, inventory);
  const destination = yield* rowsOf(store, to, inventory);
  const sourceOutput = yield* store.getOutput(from);
  const destinationOutput = yield* store.getOutput(to);
  if (source.size === 0 && destination.size === 0) return yield* Effect.die(`${from.stack}/${from.stage} and ${to.stack}/${to.stage} hold no records; there is nothing to move`);
  for (const [fqn, row] of destination) {
    const original = source.get(fqn);
    if (original && !isDeepStrictEqual(original, row)) return yield* Effect.die(`${to.stack}/${to.stage} holds a different record for ${fqn}; refusing to overwrite it`);
  }
  // A source record is removed only after every record is in the destination, so each expected
  // record must live in at least one of the two.
  for (const fqn of Object.keys(inventory)) {
    if (!source.has(fqn) && !destination.has(fqn)) return yield* Effect.die(`Record ${fqn} is in neither ${from.stack}/${from.stage} nor ${to.stack}/${to.stage}; refusing a partial move`);
  }
  if (sourceOutput !== undefined && destinationOutput !== undefined && !isDeepStrictEqual(sourceOutput, destinationOutput)) return yield* Effect.die(`${to.stack}/${to.stage} holds a different stack output; refusing to overwrite it`);
  return { source, destination, sourceOutput, destinationOutput };
});

// The destination must hold every source record, byte for byte, before anything is removed.
const verify = Effect.fn(function* (store: StateService, { to }: StateMove, inventory: Readonly<Record<string, string>>, source: ReadonlyMap<string, PersistedState>, sourceOutput: unknown) {
  const verified = yield* rowsOf(store, to, inventory);
  for (const [fqn, row] of source) {
    if (!isDeepStrictEqual(verified.get(fqn), row)) return yield* Effect.die(`Copy of ${fqn} did not verify; the old state is untouched`);
  }
  if (verified.size !== Object.keys(inventory).length) return yield* Effect.die("The destination is incomplete after the copy; the old state is untouched");
  if (sourceOutput !== undefined && !isDeepStrictEqual(yield* store.getOutput(to), sourceOutput)) return yield* Effect.die("Copy of the stack output did not verify; the old state is untouched");
});

const removeOld = Effect.fn(function* (store: StateService, { from }: StateMove, fqns: Iterable<string>) {
  for (const fqn of fqns) yield* store.delete({ ...from, fqn });
  yield* store.deleteStack(from);
  if ((yield* store.list(from)).length || (yield* store.getOutput(from)) !== undefined) return yield* Effect.die("The old state was not fully removed");
});

export const moveState = Effect.fn(function* (store: StateService, move: StateMove, inventory: Readonly<Record<string, string>>, dryRun: boolean) {
  const { source, destination, sourceOutput, destinationOutput } = yield* survey(store, move, inventory);
  const copied = [...source.keys()].filter((fqn) => !destination.has(fqn));
  const outputCopied = sourceOutput !== undefined && destinationOutput === undefined;
  const hasOldState = source.size > 0 || sourceOutput !== undefined;
  const report = { dryRun, copied, removed: hasOldState ? [...source.keys()] : [], outputCopied } satisfies StateMoveReport;
  if (dryRun) return report;
  for (const fqn of copied) {
    const row = source.get(fqn);
    if (row) yield* store.set({ ...move.to, fqn, value: row });
  }
  if (outputCopied) yield* store.setOutput({ ...move.to, value: sourceOutput });
  yield* verify(store, move, inventory, source, sourceOutput);
  if (hasOldState) yield* removeOld(store, move, source.keys());
  return report;
});
