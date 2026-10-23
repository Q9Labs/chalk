import { CaptureUpdateAction, newElementWith, reconcileElements, restoreElements } from "@excalidraw/excalidraw";

import { withLocalWhiteboardCamera, type SharedWhiteboardAppState } from "./camera";
import { WhiteboardFilesSync } from "./files";
import type { WhiteboardFileSyncState, WhiteboardFileTransferOptions } from "./files";
import { CANONICAL_INK, withInk } from "./ink";
import { compareElementOrder } from "./order";
import { WhiteboardPresence } from "./presence";
import { filterSyncableElements, remoteImageFileIds, retainStoredImages } from "./syncable";
import type { AppState, BinaryFiles, ExcalidrawElement, ExcalidrawImperativeAPI, OrderedExcalidrawElement } from "./types";
import { fromWireElement, toFittedWireElement, type WhiteboardCommit, type WhiteboardWireElement } from "./wire";

const SUBMISSION_RETRY_DELAY_MS = 1_000;
const MAX_SUBMISSION_RETRY_DELAY_MS = 16_000;
const CHANGE_DEBOUNCE_MS = 150;
// Remote cursors change the canvas too, so the debounce alone can be restarted without end.
const CHANGE_MAX_WAIT_MS = 1_000;
const CURSOR_THROTTLE_MS = 16;
const CURSOR_STALE_MS = 10_000;

const asArray = (value: unknown) => (Array.isArray(value) ? value : []);
const toReconcileRemoteElements = (elements: readonly OrderedExcalidrawElement[]): Parameters<typeof reconcileElements>[1] => elements as unknown as Parameters<typeof reconcileElements>[1];

const isNewerVersion = (element: Pick<OrderedExcalidrawElement, "version" | "versionNonce">, previous: Pick<OrderedExcalidrawElement, "version" | "versionNonce">): boolean => element.version > previous.version || (element.version === previous.version && element.versionNonce < previous.versionNonce);
const editingElementIds = (appState: ReturnType<ExcalidrawImperativeAPI["getAppState"]>) => [appState.newElement?.id, appState.resizingElement?.id, appState.editingTextElement?.id];

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
      readonly appState?: SharedWhiteboardAppState;
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
  | ({
      readonly type: "view";
      readonly participantId: string;
      readonly displayName: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly bring: boolean;
      readonly occurredAt: string;
    } & ({ readonly originParticipantId: string; readonly originSequence: number } | { readonly originParticipantId?: never; readonly originSequence?: never }))
  | {
      readonly type: "reset_required";
      readonly sceneId: string;
      readonly reason: "scene_changed" | "cursor_expired" | "gap";
    };

export interface ExcalidrawCollabEngineOptions extends WhiteboardFileTransferOptions {
  excalidrawAPI: ExcalidrawImperativeAPI;
  canDraw: boolean;
  /** Explicit management authority; omitted hosts keep the original draw-based behavior. */
  canManage?: boolean;
  submitUpdate: (payload: { sceneId: string; revision?: string; sceneGeneration?: string; syncAll: boolean; elements: readonly WhiteboardWireElement[] }) => Promise<WhiteboardCommit>;
  sendCursor: (payload: { x: number; y: number }) => void;
  requestSnapshot: () => Promise<void>;
  clear: () => Promise<WhiteboardCommit>;
  subscribe: (listener: (event: WhiteboardCollaborationEvent) => void) => () => void;
  onFileSyncStateChange?: (state: WhiteboardFileSyncState) => void;
  onSubmissionError?: (error: unknown) => void;
  /** False when the host draws its own remote cursors. */
  renderCursors?: boolean;
  /** The colour this viewer sees for Ink, which travels as one canonical colour. */
  inkColor?: string;
}

export class ExcalidrawCollabEngine {
  private sceneId: string | null = null;
  private sceneRevision: string | null = null;
  private sceneGeneration: string | null = null;
  private canDraw = true;
  private canManage: boolean | undefined;
  private inkColor: string;
  private storedImageFileIds = new Set<string>();

  private broadcastedElementVersions = new Map<string, { readonly version: number; readonly versionNonce: number }>();
  private rejectedElementVersions = new Map<string, { readonly version: number; readonly versionNonce: number }>();
  private deferredRemoteElements = new Map<string, OrderedExcalidrawElement>();
  private submissionInFlight = false;
  private dirtyDuringSubmission = false;
  private disposed = false;

  private changeDebounce: ReturnType<typeof setTimeout> | null = null;
  private changeDebounceDeadline: number | null = null;
  private submissionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private submissionRetries = 0;

  private readonly filesSync: WhiteboardFilesSync;
  private readonly presence: WhiteboardPresence;
  private readonly unsubPointerUp: (() => void) | null;
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: ExcalidrawCollabEngineOptions) {
    this.canDraw = opts.canDraw;
    this.canManage = opts.canManage;
    this.inkColor = opts.inkColor ?? CANONICAL_INK;

    this.filesSync = new WhiteboardFilesSync({
      excalidrawAPI: opts.excalidrawAPI,
      fileTransfer: opts.fileTransfer,
      presignDownload: opts.presignDownload,
      downloadThrottleMs: 500,
      onStateChange: opts.onFileSyncStateChange,
    });

    this.presence = new WhiteboardPresence({
      excalidrawAPI: opts.excalidrawAPI,
      sendCursor: opts.sendCursor,
      renderCursors: opts.renderCursors ?? true,
      throttleMs: CURSOR_THROTTLE_MS,
      staleMs: CURSOR_STALE_MS,
    });

    this.unsubPointerUp = opts.excalidrawAPI.onPointerUp?.(() => this.flushNow());
    this.unsubscribe = opts.subscribe((event) => this.handleRemoteEvent(event));
  }

  setCanDraw(next: boolean): void {
    this.canDraw = next;
  }

  setCanManage(next: boolean | undefined): void {
    this.canManage = next;
  }

  /** Repaints Ink for a new surface without a new version, so nothing is sent. */
  setInkColor(next: string): void {
    const previous = this.inkColor;
    if (next === previous) return;
    this.inkColor = next;
    const api = this.opts.excalidrawAPI;
    api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((element) => withInk(element, previous, next)), captureUpdate: CaptureUpdateAction.NEVER });
    // Native history stores the rendered colour; it must not restore ink from the old surface.
    api.history.clear();
  }

  async clear(): Promise<WhiteboardCommit> {
    if (!(this.canManage ?? this.canDraw)) throw new Error("whiteboard management is not permitted");
    const commit = await this.opts.clear();
    this.storedImageFileIds.clear();
    this.sceneId = commit.sceneId;
    this.sceneRevision = commit.revision;
    this.sceneGeneration = commit.sceneGeneration ?? null;
    this.broadcastedElementVersions.clear();
    this.rejectedElementVersions.clear();
    this.deferredRemoteElements.clear();
    this.resetSubmissionRetries();
    this.opts.excalidrawAPI.updateScene({
      elements: [],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.opts.excalidrawAPI.history.clear();
    return commit;
  }

  /** Restore only into the exact empty scene committed by this clear. */
  async clearWithUndo(): Promise<() => boolean> {
    const api = this.opts.excalidrawAPI;
    const before = api.getSceneElements();
    const commit = await this.clear();
    return () => {
      if (this.disposed || !this.canDraw || this.sceneId !== commit.sceneId || this.sceneRevision !== commit.revision || this.sceneGeneration !== (commit.sceneGeneration ?? null) || api.getSceneElementsIncludingDeleted().length > 0) return false;
      api.updateScene({ elements: before.map((element) => newElementWith(element, {})), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      return true;
    };
  }

  dispose(): void {
    if (this.disposed) return;

    const hasPendingChange = this.changeDebounce !== null || this.dirtyDuringSubmission || this.submissionRetryTimer !== null;
    this.disposed = true;

    this.clearChangeDebounce();

    if (hasPendingChange) this.flushOnDispose();

    if (this.submissionRetryTimer) clearTimeout(this.submissionRetryTimer);
    this.submissionRetryTimer = null;
    this.dirtyDuringSubmission = false;
    this.deferredRemoteElements.clear();
    this.filesSync.dispose();
    this.presence.dispose();
    this.unsubscribe();
    this.unsubPointerUp?.();
  }

  handleChange(_elements: readonly OrderedExcalidrawElement[], _appState: AppState, _files: BinaryFiles): void {
    if (this.disposed) return;

    this.applyDeferredRemoteElements();
    this.stripUnstoredImages();

    if (!this.canDraw) return;

    const now = Date.now();
    const deadline = this.changeDebounceDeadline ?? now + CHANGE_MAX_WAIT_MS;
    const wait = Math.min(CHANGE_DEBOUNCE_MS, deadline - now);
    this.clearChangeDebounce();
    this.changeDebounceDeadline = deadline;
    this.changeDebounce = setTimeout(
      () => {
        this.clearChangeDebounce();
        // The canvas never went quiet. Send what is finished; the element in hand goes out at its own pointer-up.
        this.flushNow(wait < CHANGE_DEBOUNCE_MS);
      },
      Math.max(0, wait),
    );
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
          revision: event.revision,
          ...(event.sceneGeneration ? { sceneGeneration: event.sceneGeneration } : {}),
          elements: event.elements,
          appState: event.appState,
        });
        return;
      case "update":
        this.handleRemoteData({
          sceneId: event.sceneId,
          revision: event.revision,
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
      case "view":
        return;
      case "reset_required":
        this.sceneRevision = null;
        this.requestSnapshot();
    }
  }

  handleRemoteData(payload: { sceneId: string; revision?: string; sceneGeneration?: string; syncAll: boolean; elements: readonly WhiteboardWireElement[] }): void {
    this.applyRemoteElements({
      sceneId: payload.sceneId,
      revision: payload.revision,
      ...(payload.sceneGeneration ? { sceneGeneration: payload.sceneGeneration } : {}),
      syncAll: payload.syncAll,
      remoteElements: payload.elements.map((element) => withInk(fromWireElement(element), CANONICAL_INK, this.inkColor)),
      isSnapshot: false,
    });
  }

  handleRemoteSnapshot(payload: { sceneId: string; revision?: string; sceneGeneration?: string; elements: readonly WhiteboardWireElement[]; appState?: SharedWhiteboardAppState }): void {
    this.applyRemoteElements({
      sceneId: payload.sceneId,
      revision: payload.revision,
      ...(payload.sceneGeneration ? { sceneGeneration: payload.sceneGeneration } : {}),
      syncAll: true,
      remoteElements: payload.elements.map((element) => withInk(fromWireElement(element), CANONICAL_INK, this.inkColor)),
      appState: payload.appState,
      isSnapshot: true,
    });
  }

  private stripUnstoredImages(): void {
    const elements = this.opts.excalidrawAPI.getSceneElementsIncludingDeleted();
    const retained = retainStoredImages(elements, this.storedImageFileIds);
    if (retained.length === elements.length) return;
    this.opts.excalidrawAPI.updateScene({ elements: retained, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private flushNow(skipEditing = false): void {
    if (this.disposed || this.submissionRetryTimer !== null) return;

    const context = this.submissionContext();
    if (!context) return;
    const editing = skipEditing ? editingElementIds(this.opts.excalidrawAPI.getAppState()) : [];
    const syncableAll = filterSyncableElements(retainStoredImages(context.elements, this.storedImageFileIds));
    const delta: OrderedExcalidrawElement[] = [];
    for (const el of syncableAll) {
      if (this.isUnsubmitted(el) && !editing.includes(el.id)) delta.push(el);
    }
    if (delta.length === 0) return;

    this.submit(context.sceneId, context.sceneGeneration ?? null, delta);
  }

  private flushOnDispose(): void {
    const context = this.submissionContext({ allowDisposed: true, allowInFlight: true });
    if (!context) return;

    const syncableAll = filterSyncableElements(retainStoredImages(context.elements, this.storedImageFileIds));
    const delta: OrderedExcalidrawElement[] = [];
    for (const element of syncableAll) {
      if (this.isUnsubmitted(element)) delta.push(element);
    }
    if (delta.length === 0) return;

    this.submitFinalUpdate(context.sceneId, context.sceneGeneration ?? null, delta);
  }

  private isUnsubmitted(element: OrderedExcalidrawElement): boolean {
    const rejected = this.rejectedElementVersions.get(element.id);
    if (rejected?.version === element.version && rejected.versionNonce === element.versionNonce) return false;
    const previous = this.broadcastedElementVersions.get(element.id);
    return !previous || isNewerVersion(element, previous);
  }

  private applyDeferredRemoteElements(): void {
    if (!this.sceneId || this.deferredRemoteElements.size === 0) return;
    const editing = editingElementIds(this.opts.excalidrawAPI.getAppState());
    const elements: OrderedExcalidrawElement[] = [];
    for (const [id, element] of this.deferredRemoteElements) {
      if (editing.includes(id)) continue;
      this.deferredRemoteElements.delete(id);
      elements.push(element);
    }
    if (elements.length === 0) return;
    this.applyRemoteElements({ sceneId: this.sceneId, ...(this.sceneGeneration ? { sceneGeneration: this.sceneGeneration } : {}), syncAll: false, remoteElements: elements, isSnapshot: false });
  }

  private clearChangeDebounce(): void {
    if (this.changeDebounce !== null) clearTimeout(this.changeDebounce);
    this.changeDebounce = null;
    this.changeDebounceDeadline = null;
  }

  private resetSubmissionRetries(): void {
    if (this.submissionRetryTimer !== null) clearTimeout(this.submissionRetryTimer);
    this.submissionRetryTimer = null;
    this.submissionRetries = 0;
  }

  private scheduleSubmissionRetry(): void {
    if (this.disposed || this.submissionRetryTimer !== null) return;
    const delay = Math.min(SUBMISSION_RETRY_DELAY_MS * 2 ** this.submissionRetries, MAX_SUBMISSION_RETRY_DELAY_MS);
    this.submissionRetries += 1;
    this.submissionRetryTimer = setTimeout(() => {
      this.submissionRetryTimer = null;
      this.flushNow();
    }, delay);
  }

  private submissionContext(options: { readonly allowDisposed?: boolean; readonly allowInFlight?: boolean } = {}): SubmissionContext | null {
    if (this.disposed && !options.allowDisposed) return null;
    if (!this.canDraw) return null;
    if (!this.sceneId) {
      this.requestSnapshot();
      return null;
    }
    if (this.submissionInFlight && !options.allowInFlight) {
      this.dirtyDuringSubmission = true;
      return null;
    }
    return {
      sceneId: this.sceneId,
      ...(this.sceneGeneration ? { sceneGeneration: this.sceneGeneration } : {}),
      elements: this.opts.excalidrawAPI.getSceneElementsIncludingDeleted(),
    };
  }

  private submit(sceneId: string, sceneGeneration: string | null, elements: readonly OrderedExcalidrawElement[]): void {
    const submittedElements = this.toSubmissionElements(elements);
    if (submittedElements.length === 0) return;
    this.submissionInFlight = true;
    this.dirtyDuringSubmission = false;
    let acknowledged = false;

    void Promise.resolve()
      .then(() =>
        this.opts.submitUpdate({
          sceneId,
          ...(sceneGeneration ? { sceneGeneration } : {}),
          syncAll: false,
          elements: submittedElements,
        }),
      )
      .then((commit) => {
        if (this.disposed) return;
        if (commit.sceneId !== sceneId || this.sceneId !== sceneId || this.sceneGeneration !== sceneGeneration) {
          this.requestSnapshot();
          return;
        }
        this.sceneRevision = commit.revision;
        for (const element of submittedElements) {
          const previous = this.broadcastedElementVersions.get(element.id);
          const submittedVersion = { version: element.version, versionNonce: element.version_nonce };
          if (!previous || isNewerVersion(submittedVersion, previous)) this.broadcastedElementVersions.set(element.id, submittedVersion);
        }
        this.submissionRetries = 0;
        acknowledged = true;
      })
      .catch((cause: unknown) => {
        if (this.sceneId === sceneId && this.sceneGeneration === sceneGeneration) this.scheduleSubmissionRetry();
        this.opts.onSubmissionError?.(cause);
      })
      .finally(() => {
        if (this.disposed) return;

        this.submissionInFlight = false;
        const shouldFlush = this.dirtyDuringSubmission;
        this.dirtyDuringSubmission = false;
        // A flush that had to wait for this submission goes out now. Ongoing input stays behind the debounce,
        // and an element still in hand waits for its own pointer-up.
        if (shouldFlush) this.flushNow();
        else if (acknowledged && this.changeDebounce === null) this.flushNow(true);
      });
  }

  private submitFinalUpdate(sceneId: string, sceneGeneration: string | null, elements: readonly OrderedExcalidrawElement[]): void {
    const submittedElements = this.toSubmissionElements(elements);
    if (submittedElements.length === 0) return;
    let submission: Promise<WhiteboardCommit>;
    try {
      submission = this.opts.submitUpdate({
        sceneId,
        ...(sceneGeneration ? { sceneGeneration } : {}),
        syncAll: false,
        elements: submittedElements,
      });
    } catch (cause) {
      this.opts.onSubmissionError?.(cause);
      return;
    }

    void submission.catch((cause: unknown) => this.opts.onSubmissionError?.(cause));
  }

  private toSubmissionElements(elements: readonly OrderedExcalidrawElement[]): WhiteboardWireElement[] {
    const submitted: WhiteboardWireElement[] = [];
    for (const element of elements) {
      try {
        submitted.push(toFittedWireElement(withInk(element, this.inkColor, CANONICAL_INK)));
        this.rejectedElementVersions.delete(element.id);
      } catch (cause) {
        const reported = this.rejectedElementVersions.has(element.id);
        this.rejectedElementVersions.set(element.id, { version: element.version, versionNonce: element.versionNonce });
        // The host shows this message to the writer, so it is said once for each element until that element can be sent.
        if (!reported) this.opts.onSubmissionError?.(new Error("One whiteboard item could not be shared. If it is very large, make it smaller or split it.", { cause }));
      }
    }
    return submitted;
  }

  private applyRemoteElements(args: { sceneId: string; revision?: string; sceneGeneration?: string; syncAll: boolean; remoteElements: unknown[]; appState?: SharedWhiteboardAppState; isSnapshot: boolean }) {
    const remoteSceneId = args.sceneId;
    const replacingScene = this.sceneId !== null && remoteSceneId !== this.sceneId;

    if (!this.sceneId) {
      this.sceneId = remoteSceneId;
    } else if (args.isSnapshot) {
      if (remoteSceneId !== this.sceneId) {
        this.sceneId = remoteSceneId;
        this.broadcastedElementVersions.clear();
      }
    } else if (remoteSceneId !== this.sceneId) {
      // Clear update (epoch advance): accept immediately.
      if (args.syncAll && asArray(args.remoteElements).length === 0) {
        this.sceneId = remoteSceneId;
        this.broadcastedElementVersions.clear();
      } else {
        this.requestSnapshot();
        return;
      }
    }
    if (replacingScene) {
      this.storedImageFileIds.clear();
      this.rejectedElementVersions.clear();
      this.clearChangeDebounce();
      this.dirtyDuringSubmission = false;
      this.sceneGeneration = null;
      this.deferredRemoteElements.clear();
      this.resetSubmissionRetries();
    }
    this.sceneRevision = args.revision ?? null;
    if (args.sceneGeneration) this.sceneGeneration = args.sceneGeneration;

    const excalidrawAPI = this.opts.excalidrawAPI;
    if (replacingScene) excalidrawAPI.history.clear();
    const local = replacingScene ? [] : excalidrawAPI.getSceneElementsIncludingDeleted();
    // Excalidraw takes the order of this list as the order of the elements and rewrites every order key that
    // disagrees with it. Sync lists a board by order key in its database's collation, not in the keys' own order.
    const remoteElements = [...(args.remoteElements as readonly ExcalidrawElement[])].sort(compareElementOrder);
    const received = new Map(remoteElements.map((element) => [element.id, element]));
    // Excalidraw's restore deletes an empty text and bumps its version. A peer's undone text is empty but live, and
    // a deleted copy here would be as new as the peer's Redo, so the Redo could lose the tie. Keep what arrived.
    const restoredRemote = restoreElements(remoteElements, null).map((element) => {
      const remote = received.get(element.id);
      return remote && !remote.isDeleted && element.isDeleted ? { ...element, isDeleted: false, version: remote.version, versionNonce: remote.versionNonce } : element;
    });
    this.storedImageFileIds = new Set([...this.storedImageFileIds, ...remoteImageFileIds(restoredRemote)]);
    const remoteForReconcile = toReconcileRemoteElements(restoredRemote);
    const appState = excalidrawAPI.getAppState();
    const editing = editingElementIds(appState);
    const reconciled = retainStoredImages(reconcileElements(local, remoteForReconcile, appState), this.storedImageFileIds);

    // A reconciled local draft is not evidence that the remote scene received it.
    if (args.isSnapshot) {
      this.broadcastedElementVersions.clear();
      this.resetSubmissionRetries();
    }
    const remoteById = new Map(restoredRemote.map((element) => [element.id, element]));
    for (const element of reconciled) {
      const remote = remoteById.get(element.id);
      if (remote?.version === element.version && remote.versionNonce === element.versionNonce) {
        this.broadcastedElementVersions.set(element.id, { version: element.version, versionNonce: element.versionNonce });
      } else if (remote && editing.includes(element.id) && isNewerVersion(remote, element)) {
        const previous = this.deferredRemoteElements.get(element.id);
        if (!previous || isNewerVersion(remote, previous)) this.deferredRemoteElements.set(element.id, remote);
      }
    }
    const hasUnsubmittedElements = reconciled.some((element) => this.isUnsubmitted(element));

    excalidrawAPI.updateScene({
      elements: reconciled,
      appState: withLocalWhiteboardCamera(args.appState, excalidrawAPI.getAppState()),
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.filesSync.handleRemoteScene(reconciled);
    if (args.isSnapshot && hasUnsubmittedElements) queueMicrotask(() => this.flushNow());
  }

  private requestSnapshot(): void {
    if (this.disposed) return;

    void Promise.resolve()
      .then(() => {
        if (this.disposed) return;
        return this.opts.requestSnapshot();
      })
      .catch((cause: unknown) => this.opts.onSubmissionError?.(cause));
  }
}
