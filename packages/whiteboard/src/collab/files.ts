import { CaptureUpdateAction, MIME_TYPES, newElementWith } from "@excalidraw/excalidraw";

import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI, FileId, OrderedExcalidrawElement } from "./types";

export type WhiteboardFileSyncPhase = "idle" | "awaiting_remote_upload" | "downloading" | "error";

export interface WhiteboardFileSyncState {
  phase: WhiteboardFileSyncPhase;
  remotePendingUploads: number;
  downloading: number;
  downloadQueued: number;
  lastErrorAtMs: number | null;
}

export interface WhiteboardFileTransfer {
  readonly download: (fileId: string) => Promise<{ readonly mimeType: string; readonly dataURL: string }>;
}

export interface WhiteboardFileTransferOptions {
  fileTransfer?: WhiteboardFileTransfer;
  presignDownload?: (fileId: string) => Promise<{ downloadUrl: string }>;
}

interface WhiteboardFilesSyncOptions extends WhiteboardFileTransferOptions {
  excalidrawAPI: ExcalidrawImperativeAPI;
  downloadThrottleMs?: number;
  onStateChange?: (state: WhiteboardFileSyncState) => void;
}

const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("failed to read blob"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });

type OrderedImageElement = Extract<OrderedExcalidrawElement, { type: "image" }>;

const isImageElement = (el: OrderedExcalidrawElement): el is OrderedImageElement => el.type === "image";

const toFileId = (value: string): FileId => value as FileId;

const toDataURL = (value: string): DataURL => {
  if (!value.startsWith("data:")) throw new Error("invalid dataURL");
  return value as DataURL;
};

const normalizeMimeType = (value: string): BinaryFileData["mimeType"] => {
  const [rawMimeType] = value.split(";", 1);
  const mimeType = rawMimeType?.trim().toLowerCase();

  if (mimeType === MIME_TYPES.binary) return MIME_TYPES.binary;
  if (mimeType?.startsWith("image/")) return mimeType as BinaryFileData["mimeType"];
  return MIME_TYPES.binary;
};

const updateImageStatus = (excalidrawAPI: ExcalidrawImperativeAPI, fileId: string, nextStatus: "saved" | "error") => {
  const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
  let changed = false;

  const next = elements.map((el) => {
    if (!isImageElement(el) || el.isDeleted || el.fileId !== fileId) return el;
    if (el.status === nextStatus) return el;
    changed = true;
    return newElementWith(el, { status: nextStatus });
  });

  if (!changed) return;
  excalidrawAPI.updateScene({
    elements: next,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

export class WhiteboardFilesSync {
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadQueue: string[] = [];
  private downloading = new Set<string>();

  constructor(private readonly opts: WhiteboardFilesSyncOptions) {}

  private remotePendingUploads = 0;
  private lastErrorAtMs: number | null = null;

  handleRemoteScene(elementsAll: readonly OrderedExcalidrawElement[]): void {
    const haveFiles = this.opts.excalidrawAPI.getFiles();
    let pendingRemoteUploads = 0;

    for (const el of elementsAll) {
      if (!isImageElement(el) || el.isDeleted) continue;
      if (!el.fileId) continue;

      const fileId = String(el.fileId);
      if (el.status === "pending" && !haveFiles[fileId]) {
        pendingRemoteUploads += 1;
        continue;
      }
      if (el.status !== "saved") continue;
      if (haveFiles[fileId]) continue;
      if (this.downloading.has(fileId)) continue;
      if (this.downloadQueue.includes(fileId)) continue;

      this.downloadQueue.push(fileId);
    }

    this.remotePendingUploads = pendingRemoteUploads;
    this.emitState();

    if (this.downloadQueue.length > 0) this.scheduleDownload();
  }

  dispose(): void {
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    this.downloadTimer = null;
    this.downloadQueue = [];
    this.downloading.clear();
    this.remotePendingUploads = 0;
    this.lastErrorAtMs = null;
    this.emitState();
  }

  private scheduleDownload() {
    if (this.downloadTimer) return;
    this.downloadTimer = setTimeout(() => {
      this.downloadTimer = null;
      void this.processNextDownload();
    }, this.opts.downloadThrottleMs ?? 500);
  }

  private async processNextDownload() {
    const fileId = this.downloadQueue.shift();
    if (!fileId) return;
    if (this.downloading.has(fileId)) return;

    this.downloading.add(fileId);
    this.emitState();
    try {
      let mimeType: BinaryFileData["mimeType"];
      let dataURL: DataURL;

      if (this.opts.fileTransfer) {
        const file = await this.opts.fileTransfer.download(fileId);
        mimeType = normalizeMimeType(file.mimeType);
        dataURL = toDataURL(file.dataURL);
      } else {
        const presignDownload = requireOption(this.opts.presignDownload, "presignDownload");
        const { downloadUrl } = await presignDownload(fileId);
        const res = await fetch(downloadUrl);

        if (res.status === 404) {
          this.lastErrorAtMs = Date.now();
          updateImageStatus(this.opts.excalidrawAPI, fileId, "error");
          return;
        }
        if (!res.ok) throw new Error(`download failed: ${res.status}`);

        mimeType = normalizeMimeType(res.headers.get("content-type") ?? "image/png");
        dataURL = toDataURL(await blobToDataURL(await res.blob()));
      }

      this.opts.excalidrawAPI.addFiles([
        {
          id: toFileId(fileId),
          mimeType,
          dataURL,
          created: Date.now(),
          lastRetrieved: Date.now(),
        },
      ]);
    } catch {
      // best-effort; we'll retry on next scene update
      this.lastErrorAtMs = Date.now();
    } finally {
      this.downloading.delete(fileId);
      this.emitState();
      if (this.downloadQueue.length > 0) this.scheduleDownload();
    }
  }

  private emitState() {
    const downloadQueued = this.downloadQueue.length;
    const downloading = this.downloading.size;

    const phase: WhiteboardFileSyncPhase = this.remotePendingUploads > 0 ? "awaiting_remote_upload" : downloading > 0 || downloadQueued > 0 ? "downloading" : this.lastErrorAtMs && Date.now() - this.lastErrorAtMs < 4_000 ? "error" : "idle";

    this.opts.onStateChange?.({
      phase,
      remotePendingUploads: this.remotePendingUploads,
      downloading,
      downloadQueued,
      lastErrorAtMs: this.lastErrorAtMs,
    });
  }
}

function requireOption<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`whiteboard file sync requires ${name}`);
  return value;
}
