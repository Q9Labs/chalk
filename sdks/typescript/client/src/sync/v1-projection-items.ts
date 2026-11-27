import type { MediaProjectionItemSchema, PresenceProjectionItemSchema } from "../generated/sync";
import { V1ReplicaError } from "./v1-reducer";
import type { V1MediaPublication, V1Presence, V1Projection } from "./v1-types";

export function updateProjection<T>(projection: V1Projection<T> | null, projectionId: string, sequence: number, item: T, key: (item: T) => string): V1Projection<T> {
  if (!projection || projection.projectionId !== projectionId) throw new V1ReplicaError("projection event has no matching replace snapshot");
  if (sequence !== projection.sequence + 1) throw new V1ReplicaError("projection event is not exact-next");
  const itemKey = key(item);
  return { projectionId, sequence, items: [...projection.items.filter((candidate) => key(candidate) !== itemKey), item] };
}

export function mediaItem(item: typeof MediaProjectionItemSchema.Type): V1MediaPublication {
  return {
    participantId: item.participant_id,
    source: item.source,
    enabled: item.enabled,
    publicationId: item.publication_id,
    ...(item.off_reason === undefined ? {} : { offReason: item.off_reason }),
    ...(item.off_revision === undefined ? {} : { offRevision: item.off_revision }),
  };
}

export function presenceItem(item: typeof PresenceProjectionItemSchema.Type): V1Presence {
  return {
    participantId: item.participant_id,
    admissionRevision: item.admission_revision,
    identityId: item.identity_id,
    deviceType: item.device_type,
    deviceKind: item.device_kind,
    state: item.state,
    speaking: item.speaking,
    activeSpeaker: item.active_speaker,
    ...(item.connection_quality === undefined ? {} : { connectionQuality: item.connection_quality }),
  };
}

export function mediaKey(item: V1MediaPublication): string {
  return `${item.participantId}:${item.source}`;
}

export function copyProjection<T>(projection: V1Projection<T> | null): V1Projection<T> | null {
  return projection && { ...projection, items: projection.items.map((item) => ({ ...item })) };
}

export function copyPublication(publication: V1MediaPublication): V1MediaPublication {
  return { ...publication };
}

export function validMediaPublication(publication: V1MediaPublication): boolean {
  return (
    typeof publication.participantId === "string" &&
    publication.participantId.length > 0 &&
    (publication.source === "microphone" || publication.source === "camera" || publication.source === "screen" || publication.source === "screen_audio") &&
    typeof publication.enabled === "boolean" &&
    (publication.publicationId === null || typeof publication.publicationId === "string") &&
    (!publication.enabled || publication.publicationId !== null)
  );
}
