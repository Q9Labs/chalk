export type ChalkJsonValue = null | boolean | number | string | readonly ChalkJsonValue[] | { readonly [key: string]: ChalkJsonValue };

export type ChalkWhiteboardV1Element = {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly versionNonce: number;
  readonly index: string;
  readonly isDeleted: boolean;
  readonly payload: Readonly<Record<string, ChalkJsonValue>>;
};

export type ChalkSharedWhiteboardAppState = {
  readonly viewBackgroundColor?: string;
};

export type ChalkWhiteboardV1UpdateInput = {
  readonly sceneId: string;
  readonly syncAll: boolean;
  readonly elements: readonly ChalkWhiteboardV1Element[];
};

export type ChalkWhiteboardV1Event =
  | {
      readonly type: "snapshot";
      readonly sceneId: string;
      readonly revision: string;
      readonly elements: readonly ChalkWhiteboardV1Element[];
      readonly appState?: ChalkSharedWhiteboardAppState;
    }
  | {
      readonly type: "update";
      readonly sceneId: string;
      readonly revision: string;
      readonly elements: readonly ChalkWhiteboardV1Element[];
    }
  | {
      readonly type: "cursor";
      readonly participantId: string;
      readonly displayName: string;
      readonly x: number;
      readonly y: number;
      readonly occurredAt: string;
    }
  | ({
      readonly type: "view";
      readonly participantId: string;
      readonly displayName: string;
      readonly occurredAt: string;
    } & ChalkWhiteboardView)
  | {
      readonly type: "reset_required";
      readonly sceneId: string;
      readonly reason: "scene_changed" | "cursor_expired" | "gap";
    };

/** The part of the board a person sees, in board coordinates. `bring` asks everyone to move there. */
export type ChalkWhiteboardView = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly bring: boolean;
  /** Real move by default; false marks a passive refresh or heartbeat. */
  readonly lead?: boolean;
} & ({ readonly ownerId: string; readonly ownerSequence: number } | { readonly ownerId?: never; readonly ownerSequence?: never }) &
  ({ readonly originParticipantId: string; readonly originSequence: number; readonly originEpoch?: string } | { readonly originParticipantId?: never; readonly originSequence?: never; readonly originEpoch?: never });

export type ChalkWhiteboardV1Commit = {
  readonly operationId: string;
  readonly sceneId: string;
  readonly revision: string;
};

export type ChalkWhiteboardV1Operation = "start_scene_subscription" | "submit_update" | "request_snapshot" | "clear" | "set_draw_permission" | "set_draw_policy" | "set_presentation" | "get_file_download";

/** Who can draw in the call. Hosts, the people whose role can manage the board, can always draw under `hosts` and `picked`. */
export type ChalkWhiteboardDrawPolicy = WhiteboardV1DrawPolicy;

/** A host's choice for one person. Under `everyone` it overrides the role default; under `picked` `true` means picked; under `hosts` it is kept but ignored. */
export type ChalkWhiteboardDrawPermission = {
  readonly participantId: string;
  readonly canDraw: boolean;
};

export type ChalkWhiteboardV1ErrorCode = "unavailable" | "permission_denied" | "invalid_payload" | "stale_scene" | "cursor_reset_required" | "storage_unavailable" | "file_transfer_failed";

export type ChalkWhiteboardV1Failure = {
  readonly operation: ChalkWhiteboardV1Operation;
  readonly code: ChalkWhiteboardV1ErrorCode;
  readonly recoverable: boolean;
  readonly message: string;
};

export class ChalkWhiteboardV1Error extends Error {
  readonly operation: ChalkWhiteboardV1Operation;
  readonly code: ChalkWhiteboardV1ErrorCode;
  readonly recoverable: boolean;

  constructor(failure: ChalkWhiteboardV1Failure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "ChalkWhiteboardV1Error";
    this.operation = failure.operation;
    this.code = failure.code;
    this.recoverable = failure.recoverable;
  }
}

export type ChalkWhiteboardV1FileTransport = {
  readonly getDownloadUrl: (fileId: string) => Promise<{
    readonly downloadUrl: string;
    readonly expiresAt: string;
  }>;
};

export type ChalkWhiteboardV1Transport = {
  readonly startSceneSubscription: () => Promise<void>;
  readonly stopSceneSubscription: () => void | Promise<void>;
  readonly subscribeSummary?: (listener: (summary: ChalkWhiteboardSummary) => void) => () => void;
  readonly subscribe: (listener: (event: ChalkWhiteboardV1Event) => void) => () => void;
  readonly submitUpdate: (input: ChalkWhiteboardV1UpdateInput) => Promise<ChalkWhiteboardV1Commit>;
  readonly sendCursor: (input: { readonly x: number; readonly y: number }) => void;
  /** Whether the active subscription negotiated view_v1; remains stable during recovery. */
  readonly supportsViews?: boolean;
  /** Accepts views while subscribed; keeps the latest bring through recovery. False means views are unavailable. */
  readonly forgetParticipant?: (participantId: string) => void;
  readonly sendView?: (view: ChalkWhiteboardView) => boolean;
  readonly requestSnapshot: () => Promise<void>;
  readonly clear: () => Promise<ChalkWhiteboardV1Commit>;
  readonly setDrawPermission: (participantId: string, canDraw: boolean) => Promise<void>;
  /** Sets the call-wide drawing policy. Requires manageWhiteboard and a Sync server with draw_policy_v1. */
  readonly setDrawPolicy?: (policy: ChalkWhiteboardDrawPolicy) => Promise<void>;
  readonly setPresentation?: (presenting: boolean) => Promise<void>;
  readonly files: ChalkWhiteboardV1FileTransport;
};

export type ChalkWhiteboardV1PendingOperation = {
  readonly operationId: string;
  readonly frame: Extract<WhiteboardV1ClientFrame, { readonly type: "submit_update" | "clear" | "set_draw_permission" | "set_draw_policy" | "set_presentation" }>;
  readonly createdAt: number;
  readonly bytes: number;
};

export type ChalkWhiteboardV1PendingOperationStore = {
  readonly load: () => Promise<readonly ChalkWhiteboardV1PendingOperation[]>;
  readonly put: (operation: ChalkWhiteboardV1PendingOperation) => Promise<void>;
  readonly remove: (operationId: string) => Promise<void>;
};

export type ChalkWhiteboardV1ClientOptions = {
  readonly url: string;
  readonly token: () => Promise<string>;
  readonly webSocket: SyncWebSocketFactory;
  readonly files: ChalkWhiteboardV1FileTransport;
  readonly lifecycle?: SyncLifecycle;
  /** Wall time orders persisted operations; monotonicNow returns elapsed milliseconds on the setTimeout scheduler's timeline. */
  readonly clock?: SyncClock & { readonly monotonicNow: () => number };
  readonly ids?: SyncIdGenerator;
  readonly pendingStore?: ChalkWhiteboardV1PendingOperationStore;
  readonly cursor?: { readonly sceneId: string; readonly revision: string };
  readonly reconnectDelayMs?: number;
  /** Per-attempt WebSocket opening allowance, clamped to 10–60 seconds; defaults to 10 seconds. */
  readonly dialTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly onSummary?: (summary: ChalkWhiteboardSummary) => void;
  readonly watchdog?: boolean;
  readonly onWatchdogReplacement?: (event: { readonly reason: "slow_heartbeat"; readonly roundTripsMs: readonly number[]; readonly outstandingAgesMs: readonly number[]; readonly backoffMs: number }) => void;
};

export type ChalkWhiteboardSummary = {
  readonly status: "unsubscribed" | "loading" | "ready" | "recovering" | "failed";
  readonly sceneId: string | null;
  readonly revision: string | null;
  readonly capabilities: readonly ChalkWhiteboardV1Capability[];
  /** This person's drawing permission, computed by Sync from the policy, their role and the host's choice for them. */
  readonly canDraw: boolean;
  readonly canClear: boolean;
  /** The call-wide policy, or null when the Sync server predates draw_policy_v1. */
  readonly drawPolicy: ChalkWhiteboardDrawPolicy | null;
  /** The host's per-person choices for people in the call. Empty unless this person is a host. */
  readonly drawPermissions: readonly ChalkWhiteboardDrawPermission[];
  readonly presenting: boolean;
  readonly error: ChalkWhiteboardV1Failure | null;
};
import type { WhiteboardV1ClientFrame, WhiteboardV1DrawPolicy } from "../generated/whiteboard-v1";
import type { ChalkWhiteboardV1Capability } from "../collaboration/types";
import type { SyncClock, SyncIdGenerator, SyncLifecycle, SyncWebSocketFactory } from "../sync/types";

export type { ChalkWhiteboardV1Capability } from "../collaboration/types";
