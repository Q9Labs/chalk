import { CaptureUpdateAction, hashElementsVersion, reconcileElements, restoreElements } from "@excalidraw/excalidraw";

import { WhiteboardFilesSync } from "./files";
import type { WhiteboardFileSyncState, WhiteboardFileTransferOptions } from "./files";
import { WhiteboardPresence } from "./presence";
import { filterSyncableElements } from "./syncable";
import type { AppState, BinaryFiles, ExcalidrawElement, ExcalidrawImperativeAPI, OrderedExcalidrawElement } from "./types";
import { fromWireElement, toWireElement, type WhiteboardCommit, type WhiteboardWireElement } from "./wire";

const FULL_SYNC_INTERVAL_MS = 20_000;
const CHANGE_DEBOUNCE_MS = 150;
const CURSOR_THROTTLE_MS = 16;
const CURSOR_STALE_MS = 10_000;

const asArray = (value: unknown) => (Array.isArray(value) ? value : []);
const toReconcileRemoteElements = (elements: readonly OrderedExcalidrawElement[]): Parameters<typeof reconcileElements>[1] => elements as unknown as Parameters<typeof reconcileElements>[1];

type SubmissionContext = {
  readonly sceneId: string;
  readonly sceneGeneration?: string;
  readonly elements: readonly OrderedExcalidrawElement[];
};

export type WhiteboardCollaborationEvent =
  | {
      readonly type: "snapshot";
      readonly sceneId: string;
      readonly revision: string;
      readonly sceneGeneration?: string;
      readonly elements: readonly WhiteboardWireElement[];
      readonly appState?: { readonly viewBackgroundColor?: string };
    }
  | {
      readonly type: "update";
      readonly sceneId: string;
      readonly revision: string;
      readonly sceneGeneration?: string;
      readonly elements: readonly WhiteboardWireElement[];
    }
  | {
      readonly type: "cursor";
      readonly participantId: string;
      readonly displayName: string;
      readonly x: number;
      readonly y: number;
      readonly occurredAt: string;
    }
  | {
      readonly type: "reset_required";
      readonly sceneId: string;
      readonly reason: "scene_changed" | "cursor_expired" | "gap";
    };

export interface ExcalidrawCollabEngineOptions extends WhiteboardFileTransferOptions {
  excalidrawAPI: ExcalidrawImperativeAPI;
  canDraw: boolean;
  submitUpdate: (payload: { sceneId: string; sceneGeneration?: string; syncAll: boolean; elements: readonly WhiteboardWireElement[] }) => Promise<WhiteboardCommit>;
  sendCursor: (payload: { x: number; y: number }) => void;
  requestSnapshot: () => Promise<void>;
  clear: () => Promise<WhiteboardCommit>;
  subscribe: (listener: (event: WhiteboardCollaborationEvent) => void) => () => void;
  onFileSyncStateChange?: (state: WhiteboardFileSyncState) => void;
  onSubmissionError?: (error: unknown) => void;
}

export class ExcalidrawCollabEngine {
  private sceneId: string | null = null;
  private sceneGeneration: string | null = null;
  private canDraw = true;

  private lastBroadcastedOrReceivedElementsHash = 0;
  private broadcastedElementVersions = new Map<string, number>();
  private submissionInFlight = false;
  private dirtyDuringSubmission = false;

  private changeDebounce: ReturnType<typeof setTimeout> | null = null;
  private fullSyncTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly filesSync: WhiteboardFilesSync;
  private readonly presence: WhiteboardPresence;
  private readonly unsubPointerUp: (() => void) | null;
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: ExcalidrawCollabEngineOptions) {
    this.canDraw = opts.canDraw;

    this.filesSync = new WhiteboardFilesSync({
      excalidrawAPI: opts.excalidrawAPI,
      fileTransfer: opts.fileTransfer,
      initiateUpload: opts.initiateUpload,
      finalizeUpload: opts.finalizeUpload,
      presignDownload: opts.presignDownload,
      uploadThrottleMs: 300,
      downloadThrottleMs: 500,
      onStateChange: opts.onFileSyncStateChange,
    });

    this.presence = new WhiteboardPresence({
      excalidrawAPI: opts.excalidrawAPI,
      sendCursor: opts.sendCursor,
      throttleMs: CURSOR_THROTTLE_MS,
      staleMs: CURSOR_STALE_MS,
    });

    this.unsubPointerUp = opts.excalidrawAPI.onPointerUp?.(() => this.flushNow());
    this.unsubscribe = opts.subscribe((event) => this.handleRemoteEvent(event));
  }

  setCanDraw(next: boolean): void {
    this.canDraw = next;
  }

  async clear(): Promise<WhiteboardCommit> {
    if (!this.canDraw) throw new Error("whiteboard drawing is not permitted");
    const commit = await this.opts.clear();
    this.sceneId = commit.sceneId;
    this.sceneGeneration = commit.sceneGeneration ?? null;
    this.broadcastedElementVersions.clear();
    this.lastBroadcastedOrReceivedElementsHash = 0;
    this.opts.excalidrawAPI.updateScene({
      elements: [],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    return commit;
  }

  dispose(): void {
    if (this.changeDebounce) clearTimeout(this.changeDebounce);
    if (this.fullSyncTimer) clearTimeout(this.fullSyncTimer);
    this.changeDebounce = null;
    this.fullSyncTimer = null;
    this.filesSync.dispose();
    this.presence.dispose();
    this.unsubscribe();
    this.unsubPointerUp?.();
  }

  handleChange(_elements: readonly OrderedExcalidrawElement[], _appState: AppState, files: BinaryFiles): void {
    const elementsAll = this.opts.excalidrawAPI.getSceneElementsIncludingDeleted();
    this.filesSync.handleLocalScene(elementsAll, files);

    if (!this.canDraw) return;

    if (this.changeDebounce) clearTimeout(this.changeDebounce);
    this.changeDebounce = setTimeout(() => {
      this.changeDebounce = null;
      this.flushNow();
    }, CHANGE_DEBOUNCE_MS);
  }

  handlePointerUpdate(payload: { pointer: { x: number; y: number } }): void {
    this.presence.handlePointerUpdate(payload);
  }

  handleRemoteCursor(payload: { participantId: string; displayName: string; x: number; y: number; timestamp: Date }): void {
    this.presence.handleRemoteCursor(payload);
  }

  handleRemoteEvent(event: WhiteboardCollaborationEvent): void {
    switch (event.type) {
      case "snapshot":
        this.handleRemoteSnapshot({
          sceneId: event.sceneId,
          ...(event.sceneGeneration ? { sceneGeneration: event.sceneGeneration } : {}),
          elements: event.elements,
          appState: event.appState as AppState | undefined,
        });
        return;
      case "update":
        this.handleRemoteData({
          sceneId: event.sceneId,
          ...(event.sceneGeneration ? { sceneGeneration: event.sceneGeneration } : {}),
          syncAll: false,
          elements: event.elements,
        });
        return;
      case "cursor":
        this.handleRemoteCursor({
          participantId: event.participantId,
          displayName: event.displayName,
          x: event.x,
          y: event.y,
          timestamp: new Date(event.occurredAt),
        });
        return;
      case "reset_required":
        this.requestSnapshot();
    }
  }

  handleRemoteData(payload: { sceneId: string; sceneGeneration?: string; syncAll: boolean; elements: readonly WhiteboardWireElement[] }): void {
    this.applyRemoteElements({
      sceneId: payload.sceneId,
      ...(payload.sceneGeneration ? { sceneGeneration: payload.sceneGeneration } : {}),
      syncAll: payload.syncAll,
      remoteElements: payload.elements.map(fromWireElement),
      isSnapshot: false,
    });
  }

  handleRemoteSnapshot(payload: { sceneId: string; sceneGeneration?: string; elements: readonly WhiteboardWireElement[]; appState?: AppState }): void {
    this.applyRemoteElements({
      sceneId: payload.sceneId,
      ...(payload.sceneGeneration ? { sceneGeneration: payload.sceneGeneration } : {}),
      syncAll: true,
      remoteElements: payload.elements.map(fromWireElement),
      appState: payload.appState,
      isSnapshot: true,
    });
  }

  private flushNow(): void {
    const context = this.submissionContext();
    if (!context) return;
    const elementsHash = hashElementsVersion(context.elements);
    if (elementsHash === this.lastBroadcastedOrReceivedElementsHash) return;

    const syncableAll = filterSyncableElements(context.elements);
    const delta: OrderedExcalidrawElement[] = [];
    for (const el of syncableAll) {
      const prev = this.broadcastedElementVersions.get(el.id) ?? 0;
      if (!prev || el.version > prev) delta.push(el);
    }
    if (delta.length === 0) return;

    this.submit(context.sceneId, context.sceneGeneration ?? null, false, delta, elementsHash);
  }

  private scheduleFullSync(): void {
    if (this.fullSyncTimer) return;
    this.fullSyncTimer = setTimeout(() => {
      this.fullSyncTimer = null;
      this.sendFullSync();
    }, FULL_SYNC_INTERVAL_MS);
  }

  private sendFullSync(): void {
    const context = this.submissionContext();
    if (!context) return;
    const syncableAll = filterSyncableElements(context.elements);
    this.submit(context.sceneId, context.sceneGeneration ?? null, true, syncableAll, hashElementsVersion(context.elements));
  }

  private submissionContext(): SubmissionContext | null {
    if (!this.canDraw) return null;
    if (!this.sceneId) {
      this.requestSnapshot();
      return null;
    }
    if (this.submissionInFlight) {
      this.dirtyDuringSubmission = true;
      return null;
    }
    return {
      sceneId: this.sceneId,
      ...(this.sceneGeneration ? { sceneGeneration: this.sceneGeneration } : {}),
      elements: this.opts.excalidrawAPI.getSceneElementsIncludingDeleted(),
    };
  }

  private submit(sceneId: string, sceneGeneration: string | null, syncAll: boolean, elements: readonly OrderedExcalidrawElement[], elementsHash: number): void {
    this.submissionInFlight = true;
    this.dirtyDuringSubmission = false;

    void this.opts
      .submitUpdate({
        sceneId,
        ...(sceneGeneration ? { sceneGeneration } : {}),
        syncAll,
        elements: elements.map(toWireElement),
      })
      .then((commit) => {
        if (commit.sceneId !== sceneId || this.sceneId !== sceneId || this.sceneGeneration !== sceneGeneration) {
          this.requestSnapshot();
          return;
        }
        for (const element of elements) {
          this.broadcastedElementVersions.set(element.id, element.version);
        }
        this.lastBroadcastedOrReceivedElementsHash = elementsHash;
        this.scheduleFullSync();
      })
      .catch(this.opts.onSubmissionError)
      .finally(() => {
        this.submissionInFlight = false;
        if (this.dirtyDuringSubmission) this.flushNow();
      });
  }

  private applyRemoteElements(args: { sceneId: string; sceneGeneration?: string; syncAll: boolean; remoteElements: unknown[]; appState?: AppState; isSnapshot: boolean }) {
    const remoteSceneId = args.sceneId;

    if (!this.sceneId) {
      this.sceneId = remoteSceneId;
    } else if (args.isSnapshot) {
      if (remoteSceneId !== this.sceneId) {
        this.sceneId = remoteSceneId;
        this.broadcastedElementVersions.clear();
        this.lastBroadcastedOrReceivedElementsHash = 0;
      }
    } else if (remoteSceneId !== this.sceneId) {
      // Clear update (epoch advance): accept immediately.
      if (args.syncAll && asArray(args.remoteElements).length === 0) {
        this.sceneId = remoteSceneId;
        this.broadcastedElementVersions.clear();
        this.lastBroadcastedOrReceivedElementsHash = 0;
      } else {
        this.requestSnapshot();
        return;
      }
    }
    if (args.sceneGeneration) this.sceneGeneration = args.sceneGeneration;

    const excalidrawAPI = this.opts.excalidrawAPI;
    const local = excalidrawAPI.getSceneElementsIncludingDeleted();
    const remoteElements = args.remoteElements as readonly ExcalidrawElement[];
    const restoredRemote = restoreElements(remoteElements, local);
    const remoteForReconcile = toReconcileRemoteElements(restoredRemote);
    const reconciled = reconcileElements(local, remoteForReconcile, excalidrawAPI.getAppState());

    // Echo prevention: update before applying so onChange sees it and bails.
    this.lastBroadcastedOrReceivedElementsHash = hashElementsVersion(reconciled);
    this.broadcastedElementVersions.clear();
    for (const el of reconciled) {
      this.broadcastedElementVersions.set(el.id, el.version);
    }

    excalidrawAPI.updateScene({
      elements: reconciled,
      appState: args.appState,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.filesSync.handleRemoteScene(reconciled);
  }

  private requestSnapshot(): void {
    void Promise.resolve()
      .then(() => this.opts.requestSnapshot())
      .catch((cause: unknown) => this.opts.onSubmissionError?.(cause));
  }
}
