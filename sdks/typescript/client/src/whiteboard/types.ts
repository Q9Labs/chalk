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
} & ({ readonly originParticipantId: string; readonly originSequence: number; readonly originEpoch?: string } | { readonly originParticipantId?: never; readonly originSequence?: never; readonly originEpoch?: never });

export type ChalkWhiteboardV1Commit = {
  readonly operationId: string;
  readonly sceneId: string;
  readonly revision: string;
};

export type ChalkWhiteboardV1Operation = "start_scene_subscription" | "submit_update" | "request_snapshot" | "clear" | "set_draw_permission" | "set_presentation" | "get_file_download";

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
  readonly sendView?: (view: ChalkWhiteboardView) => boolean;
  readonly requestSnapshot: () => Promise<void>;
  readonly clear: () => Promise<ChalkWhiteboardV1Commit>;
  readonly setDrawPermission: (participantId: string, canDraw: boolean) => Promise<void>;
  readonly setPresentation?: (presenting: boolean) => Promise<void>;
  readonly files: ChalkWhiteboardV1FileTransport;
};

export type ChalkWhiteboardV1PendingOperation = {
  readonly operationId: string;
  readonly frame: Extract<WhiteboardV1ClientFrame, { readonly type: "submit_update" | "clear" | "set_draw_permission" | "set_presentation" }>;
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
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly presenting: boolean;
  readonly error: ChalkWhiteboardV1Failure | null;
};
import type { WhiteboardV1ClientFrame } from "../generated/whiteboard-v1";
import type { ChalkWhiteboardV1Capability } from "../collaboration/types";
import type { SyncClock, SyncIdGenerator, SyncLifecycle, SyncWebSocketFactory } from "../sync/types";

export type { ChalkWhiteboardV1Capability } from "../collaboration/types";
