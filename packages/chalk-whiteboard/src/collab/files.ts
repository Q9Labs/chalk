import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";

import type { BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI, OrderedExcalidrawElement } from "./types";

export type WhiteboardFileSyncPhase = "idle" | "uploading" | "awaiting_remote_upload" | "downloading" | "error";

export interface WhiteboardFileSyncState {
  phase: WhiteboardFileSyncPhase;
  uploading: number;
  uploadQueued: number;
  remotePendingUploads: number;
  downloading: number;
  downloadQueued: number;
  lastErrorAtMs: number | null;
}

const dataURLToBlob = (dataURL: string) => {
  const [header, base64] = dataURL.split(",", 2);
  if (!header || !base64) throw new Error("invalid dataURL");

  const match = /data:(.+?)(;base64)?$/i.exec(header);
  const mimeType = match?.[1] ?? "application/octet-stream";
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
};

const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("failed to read blob"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });

const isImageElement = (el: any): el is { type: "image"; fileId: string | null; status: string; isDeleted?: boolean } => el && el.type === "image";

const updateImageStatus = (excalidrawAPI: ExcalidrawImperativeAPI, fileId: string, nextStatus: "saved" | "error") => {
  const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
  let changed = false;

  const next = elements.map((el) => {
    if (!isImageElement(el) || el.isDeleted || el.fileId !== fileId) return el;
    if (el.status === nextStatus) return el;
    changed = true;
    return newElementWith(el as any, { status: nextStatus }) as any;
  });

  if (!changed) return;
  excalidrawAPI.updateScene({
    elements: next as any,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

export class WhiteboardFilesSync {
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;
  private uploadQueue: string[] = [];
  private downloadQueue: string[] = [];
  private uploading = new Set<string>();
  private downloading = new Set<string>();

  constructor(
    private readonly opts: {
      excalidrawAPI: ExcalidrawImperativeAPI;
      presignUpload: (fileId: string, mimeType: string) => Promise<{ uploadUrl: string }>;
      presignDownload: (fileId: string) => Promise<{ downloadUrl: string }>;
      uploadThrottleMs?: number;
      downloadThrottleMs?: number;
      onStateChange?: (state: WhiteboardFileSyncState) => void;
    },
  ) {}

  private remotePendingUploads = 0;
  private lastErrorAtMs: number | null = null;

  handleLocalScene(elementsAll: readonly OrderedExcalidrawElement[], files: BinaryFiles): void {
    for (const el of elementsAll as any[]) {
      if (!isImageElement(el) || el.isDeleted) continue;
      if (el.status !== "pending") continue;
      if (!el.fileId) continue;

      const fileId = String(el.fileId);
      if (this.uploading.has(fileId)) continue;
      if (this.uploadQueue.includes(fileId)) continue;

      const file = (files as any)[fileId] as BinaryFileData | undefined;
      if (!file?.dataURL || !file?.mimeType) continue;

      this.uploadQueue.push(fileId);
    }

    this.emitState();

    if (this.uploadQueue.length > 0) this.scheduleUpload();
  }

  handleRemoteScene(elementsAll: readonly OrderedExcalidrawElement[]): void {
    const haveFiles = this.opts.excalidrawAPI.getFiles();
    let pendingRemoteUploads = 0;

    for (const el of elementsAll as any[]) {
      if (!isImageElement(el) || el.isDeleted) continue;
      if (!el.fileId) continue;

      const fileId = String(el.fileId);
      if (el.status === "pending" && !(haveFiles as any)[fileId]) {
        pendingRemoteUploads += 1;
        continue;
      }
      if (el.status !== "saved") continue;
      if ((haveFiles as any)[fileId]) continue;
      if (this.downloading.has(fileId)) continue;
      if (this.downloadQueue.includes(fileId)) continue;

      this.downloadQueue.push(fileId);
    }

    this.remotePendingUploads = pendingRemoteUploads;
    this.emitState();

    if (this.downloadQueue.length > 0) this.scheduleDownload();
  }

  dispose(): void {
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    this.uploadTimer = null;
    this.downloadTimer = null;
    this.uploadQueue = [];
    this.downloadQueue = [];
    this.uploading.clear();
    this.downloading.clear();
    this.remotePendingUploads = 0;
    this.lastErrorAtMs = null;
    this.emitState();
  }

  private scheduleUpload() {
    if (this.uploadTimer) return;
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      void this.processNextUpload();
    }, this.opts.uploadThrottleMs ?? 300);
  }

  private scheduleDownload() {
    if (this.downloadTimer) return;
    this.downloadTimer = setTimeout(() => {
      this.downloadTimer = null;
      void this.processNextDownload();
    }, this.opts.downloadThrottleMs ?? 500);
  }

  private async processNextUpload() {
    const fileId = this.uploadQueue.shift();
    if (!fileId) return;
    if (this.uploading.has(fileId)) return;

    const files = this.opts.excalidrawAPI.getFiles();
    const file = (files as any)[fileId] as BinaryFileData | undefined;
    if (!file?.dataURL || !file?.mimeType) {
      if (this.uploadQueue.length > 0) this.scheduleUpload();
      return;
    }

    this.uploading.add(fileId);
    this.emitState();
    try {
      const { uploadUrl } = await this.opts.presignUpload(fileId, file.mimeType);
      const blob = dataURLToBlob(file.dataURL);

      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.mimeType },
        body: blob,
      });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);

      updateImageStatus(this.opts.excalidrawAPI, fileId, "saved");
    } catch {
      this.lastErrorAtMs = Date.now();
      updateImageStatus(this.opts.excalidrawAPI, fileId, "error");
    } finally {
      this.uploading.delete(fileId);
      this.emitState();
      if (this.uploadQueue.length > 0) this.scheduleUpload();
    }
  }

  private async processNextDownload() {
    const fileId = this.downloadQueue.shift();
    if (!fileId) return;
    if (this.downloading.has(fileId)) return;

    this.downloading.add(fileId);
    this.emitState();
    try {
      const { downloadUrl } = await this.opts.presignDownload(fileId);
      const res = await fetch(downloadUrl);

      if (res.status === 404) {
        this.lastErrorAtMs = Date.now();
        updateImageStatus(this.opts.excalidrawAPI, fileId, "error");
        return;
      }
      if (!res.ok) throw new Error(`download failed: ${res.status}`);

      const mimeType = res.headers.get("content-type") ?? "image/png";
      const blob = await res.blob();
      const dataURL = await blobToDataURL(blob);

      this.opts.excalidrawAPI.addFiles([
        {
          id: fileId as any,
          mimeType: mimeType as any,
          dataURL: dataURL as any,
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
    const uploadQueued = this.uploadQueue.length;
    const uploading = this.uploading.size;
    const downloadQueued = this.downloadQueue.length;
    const downloading = this.downloading.size;

    const phase: WhiteboardFileSyncPhase = uploading > 0 || uploadQueued > 0 ? "uploading" : this.remotePendingUploads > 0 ? "awaiting_remote_upload" : downloading > 0 || downloadQueued > 0 ? "downloading" : this.lastErrorAtMs && Date.now() - this.lastErrorAtMs < 4_000 ? "error" : "idle";

    this.opts.onStateChange?.({
      phase,
      uploading,
      uploadQueued,
      remotePendingUploads: this.remotePendingUploads,
      downloading,
      downloadQueued,
      lastErrorAtMs: this.lastErrorAtMs,
    });
  }
}
