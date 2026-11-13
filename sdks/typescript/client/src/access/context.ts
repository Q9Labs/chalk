import type { ParticipantMediaCredential } from "./grant";
export type AccessReason = "join" | "refresh" | "retry";
export type AccessContext = {
  readonly space: string;
  readonly reason: AccessReason;
  /** Forward to the access endpoint so media recovery can obtain a fresh connection. */
  readonly replaceMediaConnection: boolean;
  /** Automatic replacement succeeds only while this media binding is current. Omit for explicit takeover. */
  readonly expectedMediaConnectionId?: string;
  /** Forward unchanged for replay-safe recovery. Never log credentials. */
  readonly currentMediaToken?: string;
  readonly signal?: AbortSignal;
};
export type ConnectionAccessReason = "join" | "scheduled_refresh" | "sync_recovery" | "media_recovery" | "access_retry";
export type ConnectionAccessRequest = {
  readonly reason: ConnectionAccessReason;
  readonly replaceMediaConnection: boolean;
  readonly signal?: AbortSignal;
  readonly currentMediaToken?: ParticipantMediaCredential;
  readonly expectedParticipantGeneration?: number;
  readonly expectedMediaConnectionId?: string;
};
