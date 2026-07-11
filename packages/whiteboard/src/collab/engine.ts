import { CaptureUpdateAction, hashElementsVersion, reconcileElements, restoreElements } from "@excalidraw/excalidraw";

import { WhiteboardFilesSync } from "./files.js";
import type { WhiteboardFileSyncState } from "./files.js";
import { WhiteboardPresence } from "./presence.js";
import { filterSyncableElements } from "./syncable.js";
import type { AppState, BinaryFiles, ExcalidrawElement, ExcalidrawImperativeAPI, OrderedExcalidrawElement } from "./types.js";

const FULL_SYNC_INTERVAL_MS = 20_000;
const CHANGE_DEBOUNCE_MS = 150;
const CURSOR_THROTTLE_MS = 16;
const CURSOR_STALE_MS = 10_000;

const asArray = (value: unknown) => (Array.isArray(value) ? value : []);
const toReconcileRemoteElements = (elements: readonly OrderedExcalidrawElement[]): Parameters<typeof reconcileElements>[1] => elements as unknown as Parameters<typeof reconcileElements>[1];

export class ExcalidrawCollabEngine {
  private sceneId: string | null = null;
  private canDraw = true;

  private localSeq = 0;
  private lastBroadcastedOrReceivedElementsHash = 0;
  private broadcastedElementVersions = new Map<string, number>();

  private changeDebounce: ReturnType<typeof setTimeout> | null = null;
  private fullSyncTimer: ReturnType<typeof setTimeout> | null = null;

  private hadAnyElements = false;

  private readonly filesSync: WhiteboardFilesSync;
  private readonly presence: WhiteboardPresence;
  private readonly unsubPointerUp: (() => void) | null;

  constructor(
    private readonly opts: {
      excalidrawAPI: ExcalidrawImperativeAPI;
      canDraw: boolean;
      sendUpdateV2: (payload: { schemaVersion: 2; sceneId: string; syncAll: boolean; elements: readonly OrderedExcalidrawElement[]; seq: number }) => void;
      sendCursor: (payload: { x: number; y: number }) => void;
      requestSync: () => void;
      sendClear?: () => void;
      presignUpload: (fileId: string, mimeType: string) => Promise<{ uploadUrl: string }>;
      presignDownload: (fileId: string) => Promise<{ downloadUrl: string }>;
      onFileSyncStateChange?: (state: WhiteboardFileSyncState) => void;
    },
  ) {
    this.canDraw = opts.canDraw;

    this.filesSync = new WhiteboardFilesSync({
      excalidrawAPI: opts.excalidrawAPI,
      presignUpload: opts.presignUpload,
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
  }

  setCanDraw(next: boolean): void {
    this.canDraw = next;
  }

  dispose(): void {
    if (this.changeDebounce) clearTimeout(this.changeDebounce);
    if (this.fullSyncTimer) clearTimeout(this.fullSyncTimer);
    this.changeDebounce = null;
    this.fullSyncTimer = null;
    this.filesSync.dispose();
    this.presence.dispose();
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

  handleRemoteData(payload: { sceneId: string; syncAll: boolean; elements: unknown[] }): void {
    this.applyRemoteElements({
      sceneId: payload.sceneId,
      syncAll: payload.syncAll,
      remoteElements: payload.elements,
      isSnapshot: false,
    });
  }

  handleRemoteSnapshot(payload: { sceneId: string; elements: unknown[]; appState?: AppState }): void {
    this.applyRemoteElements({
      sceneId: payload.sceneId,
      syncAll: true,
      remoteElements: payload.elements,
      appState: payload.appState,
      isSnapshot: true,
    });
  }

  private flushNow(): void {
    if (!this.canDraw) return;
    if (!this.sceneId) {
      this.opts.requestSync();
      return;
    }

    const excalidrawAPI = this.opts.excalidrawAPI;
    const elementsAll = excalidrawAPI.getSceneElementsIncludingDeleted();

    const nonDeletedCount = elementsAll.filter((el) => !el.isDeleted).length;
    const hasAny = nonDeletedCount > 0;
    const becameEmpty = this.hadAnyElements && !hasAny;
    this.hadAnyElements = this.hadAnyElements || hasAny;

    if (becameEmpty && this.opts.sendClear) {
      // Canvas cleared locally. Advance epoch to prevent resurrection from in-flight updates.
      this.opts.sendClear();
      this.sceneId = null;
      this.broadcastedElementVersions.clear();
      this.lastBroadcastedOrReceivedElementsHash = 0;
      this.hadAnyElements = false;
      this.opts.requestSync();
      return;
    }

    const elementsHash = hashElementsVersion(elementsAll);
    if (elementsHash === this.lastBroadcastedOrReceivedElementsHash) return;

    const nowMs = Date.now();
    const syncableAll = filterSyncableElements(elementsAll, nowMs);

    const delta: OrderedExcalidrawElement[] = [];
    for (const el of syncableAll) {
      const prev = this.broadcastedElementVersions.get(el.id) ?? 0;
      if (!prev || el.version > prev) delta.push(el);
    }
    if (delta.length === 0) return;

    this.localSeq += 1;
    this.opts.sendUpdateV2({
      schemaVersion: 2,
      sceneId: this.sceneId,
      syncAll: false,
      elements: delta,
      seq: this.localSeq,
    });

    for (const el of delta) {
      this.broadcastedElementVersions.set(el.id, el.version);
    }

    this.lastBroadcastedOrReceivedElementsHash = elementsHash;
    this.scheduleFullSync();
  }

  private scheduleFullSync() {
    if (this.fullSyncTimer) return;
    this.fullSyncTimer = setTimeout(() => {
      this.fullSyncTimer = null;
      this.sendFullSync();
    }, FULL_SYNC_INTERVAL_MS);
  }

  private sendFullSync() {
    if (!this.canDraw) return;
    if (!this.sceneId) {
      this.opts.requestSync();
      return;
    }

    const excalidrawAPI = this.opts.excalidrawAPI;
    const elementsAll = excalidrawAPI.getSceneElementsIncludingDeleted();
    const syncableAll = filterSyncableElements(elementsAll, Date.now());

    this.localSeq += 1;
    this.opts.sendUpdateV2({
      schemaVersion: 2,
      sceneId: this.sceneId,
      syncAll: true,
      elements: syncableAll,
      seq: this.localSeq,
    });

    for (const el of syncableAll) {
      this.broadcastedElementVersions.set(el.id, el.version);
    }

    this.lastBroadcastedOrReceivedElementsHash = hashElementsVersion(elementsAll);
  }

  private applyRemoteElements(args: { sceneId: string; syncAll: boolean; remoteElements: unknown[]; appState?: AppState; isSnapshot: boolean }) {
    const remoteSceneId = args.sceneId;

    if (!this.sceneId) {
      this.sceneId = remoteSceneId;
    } else if (args.isSnapshot) {
      if (remoteSceneId !== this.sceneId) {
        this.sceneId = remoteSceneId;
        this.broadcastedElementVersions.clear();
        this.lastBroadcastedOrReceivedElementsHash = 0;
        this.hadAnyElements = false;
      }
    } else if (remoteSceneId !== this.sceneId) {
      // Clear update (epoch advance): accept immediately.
      if (args.syncAll && asArray(args.remoteElements).length === 0) {
        this.sceneId = remoteSceneId;
        this.broadcastedElementVersions.clear();
        this.lastBroadcastedOrReceivedElementsHash = 0;
        this.hadAnyElements = false;
      } else {
        this.opts.requestSync();
        return;
      }
    }

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
      if (!el.isDeleted) this.hadAnyElements = true;
    }

    excalidrawAPI.updateScene({
      elements: reconciled,
      appState: args.appState,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.filesSync.handleRemoteScene(reconciled);
  }
}
