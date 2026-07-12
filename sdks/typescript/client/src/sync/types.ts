export const SYNC_PROTOCOL_VERSION = 2 as const;

export type SyncConnectionState =
  | { readonly phase: "idle" }
  | { readonly phase: "connecting"; readonly attempt: number }
  | { readonly phase: "authenticating"; readonly attempt: number }
  | { readonly phase: "recovering"; readonly attempt: number; readonly recoveryId?: string }
  | { readonly phase: "live"; readonly attempt: number }
  | { readonly phase: "backoff"; readonly attempt: number; readonly retryAt: number }
  | { readonly phase: "ended"; readonly reason: "session_ended" }
  | { readonly phase: "stopped"; readonly reason: "stopped" | "rejoin_required" | "protocol_error" };

export type ControlParticipant = {
  readonly participantSessionId: string;
  readonly displayName: string;
  readonly handRaised: boolean;
};

export type ControlState = {
  readonly participants: readonly ControlParticipant[];
  readonly status: "active" | "ended";
};

export type CanonicalReplica = {
  readonly revision: number;
  readonly stateSchemaVersion: number;
  readonly stateDigest: string;
  readonly state: ControlState;
};

export type ControlEvent =
  | {
      readonly eventId: string;
      readonly name: "participant_joined";
      readonly baseRevision: number;
      readonly revision: number;
      readonly stateSchemaVersion: number;
      readonly resultingStateDigest: string;
      readonly commandId?: string;
      readonly lifecycleIntentId?: string;
      readonly payload: { readonly participantSessionId: string; readonly displayName: string };
    }
  | {
      readonly eventId: string;
      readonly name: "participant_left";
      readonly baseRevision: number;
      readonly revision: number;
      readonly stateSchemaVersion: number;
      readonly resultingStateDigest: string;
      readonly commandId?: string;
      readonly lifecycleIntentId?: string;
      readonly payload: { readonly participantSessionId: string };
    }
  | {
      readonly eventId: string;
      readonly name: "hand_raised" | "hand_lowered";
      readonly baseRevision: number;
      readonly revision: number;
      readonly stateSchemaVersion: number;
      readonly resultingStateDigest: string;
      readonly commandId?: string;
      readonly lifecycleIntentId?: string;
      readonly payload: { readonly participantSessionId: string };
    }
  | {
      readonly eventId: string;
      readonly name: "session_ended";
      readonly baseRevision: number;
      readonly revision: number;
      readonly stateSchemaVersion: number;
      readonly resultingStateDigest: string;
      readonly commandId?: string;
      readonly lifecycleIntentId?: string;
      readonly payload: Record<string, never>;
    };

export type SyncCommand = {
  readonly name: "raise_hand" | "lower_hand";
  readonly payload?: Readonly<Record<string, unknown>>;
};

export type PendingCommand = {
  readonly commandId: string;
  readonly command: SyncCommand;
  readonly createdAt: number;
  readonly bytes: number;
};

export type TerminalRejectionReason = "session_ended" | "participant_inactive" | "stale_participant_generation" | "capability_denied" | "invalid_state" | "command_id_conflict";

export type RetryableCommandErrorCode = "overloaded" | "server_draining" | "dependency_unavailable" | "decision_unavailable";

export type ProtocolErrorCode = "protocol_error" | "invalid_frame" | "unsupported_protocol";

export type SyncCommandFailure = {
  readonly commandId: string;
  readonly kind: "terminal_rejection" | "expired" | "capacity";
  readonly reason: TerminalRejectionReason | "pending_command_expired" | "pending_store_capacity_exceeded";
  readonly at: number;
};

export type SyncHead = {
  readonly revision: number;
  readonly stateSchemaVersion: number;
  readonly stateDigest: string;
};

export type SnapshotRecovery = {
  readonly state: ControlState;
  readonly revision: number;
  readonly stateSchemaVersion: number;
  readonly stateDigest: string;
};

export type WelcomeFrame = {
  readonly type: "welcome";
  readonly protocol: typeof SYNC_PROTOCOL_VERSION;
  readonly participantSessionId: string;
  readonly participantSessionGeneration: number;
  readonly recoveryId: string;
  readonly mode: "snapshot" | "replay" | "up_to_date" | "terminal";
  readonly head: SyncHead;
  readonly snapshot?: SnapshotRecovery;
  readonly terminalReason?: "session_ended" | "participant_inactive" | "stale_participant_generation";
};

export type ReplayPageFrame = {
  readonly type: "replay_page";
  readonly recoveryId: string;
  readonly firstRevision: number;
  readonly lastRevision: number;
  readonly events: readonly ControlEvent[];
};

export type RecoveryCompleteFrame = {
  readonly type: "recovery_complete";
  readonly recoveryId: string;
  readonly head: SyncHead;
};

export type EventFrame = ControlEvent & { readonly type: "event" };

export type AckFrame = { readonly type: "ack"; readonly commandId: string; readonly result: "committed" | "duplicate"; readonly eventId: string; readonly revision: number } | { readonly type: "ack"; readonly commandId: string; readonly result: "rejected"; readonly reason: TerminalRejectionReason };

export type CommittedAck = Extract<AckFrame, { readonly result: "committed" | "duplicate" }>;

export type RejectedAck = Extract<AckFrame, { readonly result: "rejected" }>;

export type RetryableErrorFrame = {
  readonly type: "retryable_error";
  readonly commandId: string;
  readonly code: RetryableCommandErrorCode;
};

export type ProtocolErrorFrame = {
  readonly type: "error";
  readonly code: ProtocolErrorCode;
};

export type ServerFrame = WelcomeFrame | ReplayPageFrame | RecoveryCompleteFrame | EventFrame | AckFrame | RetryableErrorFrame | ProtocolErrorFrame | { readonly type: "pong" };

export type ServerErrorFrame = Extract<ServerFrame, { readonly type: "error" }>;

export type ClientFrame =
  | {
      readonly type: "hello";
      readonly protocol: typeof SYNC_PROTOCOL_VERSION;
      readonly token: string;
      readonly streams: { readonly control: { readonly cursor: SyncHead | null } };
    }
  | { readonly type: "command"; readonly commandId: string; readonly name: SyncCommand["name"]; readonly payload?: Readonly<Record<string, unknown>> }
  | { readonly type: "delivery_ack"; readonly stream: "control"; readonly revision: number; readonly stateDigest: string }
  | { readonly type: "recovery_ack"; readonly recoveryId: string; readonly revision: number; readonly stateDigest: string }
  | { readonly type: "ping" };

export type SyncLifecycleEvent = "online" | "offline" | "active" | "inactive";

export type SyncLifecycle = {
  readonly subscribe: (listener: (event: SyncLifecycleEvent) => void) => () => void;
};

export type SyncSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type SyncWebSocketFactory = {
  readonly connect: (url: string) => SyncSocket;
};

export type SyncClock = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

export type SyncRandom = () => number;

export type SyncIdGenerator = {
  readonly next: () => string;
};

export type SyncSnapshot = {
  readonly connection: SyncConnectionState;
  readonly canonical: CanonicalReplica | null;
  readonly optimistic: ControlState;
  readonly pending: { readonly count: number; readonly bytes: number; readonly commands: readonly PendingCommand[] };
  readonly failures: readonly SyncCommandFailure[];
};
