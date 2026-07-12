import { reduceCanonicalEvent, restoreSnapshot } from "./client-state";
import { RecoveryValidationError } from "./recovery";
import { SYNC_PROTOCOL_VERSION } from "./types";
import type { CanonicalReplica, ClientFrame, CommittedAck, ControlEvent, WelcomeFrame } from "./types";

export function helloFrame(token: string, canonical: CanonicalReplica | null): ClientFrame {
  return {
    type: "hello",
    protocol: SYNC_PROTOCOL_VERSION,
    token,
    streams: {
      control: {
        cursor: canonical && {
          revision: canonical.revision,
          stateSchemaVersion: canonical.stateSchemaVersion,
          stateDigest: canonical.stateDigest,
        },
      },
    },
  };
}

export function canonicalRevision(canonical: CanonicalReplica | null): number {
  return canonical?.revision ?? -1;
}

export function requireSnapshot(frame: WelcomeFrame): NonNullable<WelcomeFrame["snapshot"]> {
  if (!frame.snapshot) {
    throw new RecoveryValidationError("snapshot welcome has no snapshot");
  }
  return frame.snapshot;
}

export function requireRestoredCanonical(restored: Awaited<ReturnType<typeof restoreSnapshot>>): CanonicalReplica {
  if (restored.ok) {
    return restored.canonical;
  }
  if (restored.error === "invalid_state") {
    throw new RecoveryValidationError("snapshot contains an invalid durable state");
  }
  throw new RecoveryValidationError("snapshot digest does not match its state");
}

export function requireCanonical(canonical: CanonicalReplica | null): CanonicalReplica {
  if (!canonical) {
    throw new RecoveryValidationError("received an event without a canonical replica");
  }
  return canonical;
}

export function requireReducedCanonical(reduced: Awaited<ReturnType<typeof reduceCanonicalEvent>>): CanonicalReplica {
  if (reduced.ok) {
    return reduced.canonical;
  }
  if (reduced.error === "reducer") {
    throw new RecoveryValidationError(`control reducer rejected event: ${reduced.reducerError}`);
  }
  throw new RecoveryValidationError("event digest does not match reduced state");
}

export function canonicalIncludesRevision(canonical: CanonicalReplica | null, revision: number): boolean {
  return canonical !== null && canonical.revision >= revision;
}

export function sameAcknowledgement(left: Pick<CommittedAck, "eventId" | "revision">, right: Pick<ControlEvent | CommittedAck, "eventId" | "revision">): boolean {
  return left.eventId === right.eventId && left.revision === right.revision;
}
