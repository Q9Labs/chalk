import type { ChalkParticipantMediaState } from "../collaboration/types";
import type { V1AdmissionPolicy, V1AdmissionTarget } from "../sync/v1-types";
import type { Capability } from "./types";

export type ParticipantPresence = {
  readonly state: "connected" | "disconnected" | "unknown";
  readonly speaking: boolean;
  readonly activeSpeaker: boolean;
  /** How well this person's own link carries the call, as they rate it. Absent when unknown. */
  readonly connectionQuality?: import("../media/link-quality").LinkTier;
};
export type Participant = {
  /** Whether this seat belongs to a person or an admitted agent. Absent on older Sync connections. */
  readonly identityKind?: "user" | "agent" | "guest";
  /** Stable person identity, independent of the per-device participant ID. */
  readonly identityId?: string;
  readonly deviceType?: "phone" | "tablet" | "computer";
  readonly participantId: string;
  readonly displayName: string;
  readonly role: string;
  readonly eligibleRoles: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly handRaised: boolean;
  readonly media: ChalkParticipantMediaState;
  readonly presence: ParticipantPresence;
};
export type AdmissionRequest = {
  readonly requestId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly initialRole: string;
  readonly eligibleRoles: readonly string[];
  readonly expiresAt: string;
};
/** Who can join without a host: "open" lets anyone with the link in, "knock" asks a host first, and "members_only" is set by the Space and cannot be changed from the call. */
export type AdmissionPolicy = V1AdmissionPolicy;
/** The policies a host can set from the call. */
export type AdmissionPolicyTarget = V1AdmissionTarget;
export type ParticipantsSlice = {
  readonly roster: readonly Participant[];
  readonly admissionQueue: readonly AdmissionRequest[];
  /** Null until Sync has sent the call's control state. */
  readonly admissionPolicy: AdmissionPolicy | null;
};
