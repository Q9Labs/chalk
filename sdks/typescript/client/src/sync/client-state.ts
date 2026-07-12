import { canonicalJsonBytesFromUnknown, computeStateDigest } from "./canonical";
import { emptyControlState, isValidControlState, optimisticControlState, reduceControlEvent } from "./reducer";
import type { CanonicalReplica, ControlEvent, ControlState, PendingCommand, SnapshotRecovery, SyncCommand } from "./types";

export type SnapshotRestoreResult = { readonly ok: true; readonly canonical: CanonicalReplica } | { readonly ok: false; readonly error: "invalid_state" | "digest_mismatch" };
export type EventReductionResult = { readonly ok: true; readonly canonical: CanonicalReplica } | { readonly ok: false; readonly error: "reducer" | "digest_mismatch"; readonly reducerError?: string };

export function optimisticSnapshotState(canonical: CanonicalReplica | null, participantSessionId: string | null, pending: readonly PendingCommand[]): ControlState {
  return copyState(optimisticControlState(canonical?.state ?? emptyControlState(), participantSessionId, pending));
}

export async function restoreSnapshot(snapshot: SnapshotRecovery): Promise<SnapshotRestoreResult> {
  if (!isValidControlState(snapshot.state)) {
    return { ok: false, error: "invalid_state" };
  }
  const digest = await computeStateDigest(snapshot.state, snapshot.revision, snapshot.stateSchemaVersion);
  if (digest !== snapshot.stateDigest) {
    return { ok: false, error: "digest_mismatch" };
  }
  return { ok: true, canonical: { revision: snapshot.revision, stateSchemaVersion: snapshot.stateSchemaVersion, stateDigest: snapshot.stateDigest, state: copyState(snapshot.state) } };
}

export async function reduceCanonicalEvent(canonical: CanonicalReplica, event: ControlEvent): Promise<EventReductionResult> {
  const reduced = reduceControlEvent(canonical, event);
  if (!reduced.ok) {
    return { ok: false, error: "reducer", reducerError: reduced.error };
  }
  const stateDigest = await computeStateDigest(reduced.state, reduced.revision, reduced.stateSchemaVersion);
  if (stateDigest !== event.resultingStateDigest) {
    return { ok: false, error: "digest_mismatch" };
  }
  return { ok: true, canonical: { revision: reduced.revision, stateSchemaVersion: reduced.stateSchemaVersion, stateDigest, state: reduced.state } };
}

export function pendingCommandBytes(commandId: string, command: SyncCommand): number {
  return canonicalJsonBytesFromUnknown({ command_id: commandId, name: command.name, payload: command.payload ?? {} }).byteLength;
}

export function copyState(state: ControlState): ControlState {
  return { status: state.status, participants: state.participants.map((participant) => ({ ...participant })) };
}

export function copyReplica(replica: CanonicalReplica): CanonicalReplica {
  return { ...replica, state: copyState(replica.state) };
}
