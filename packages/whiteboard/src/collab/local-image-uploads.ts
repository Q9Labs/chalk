import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { retainStoredImages } from "./syncable";
import { decodeWhiteboardImageDataURL } from "./file-data";
import { updateImageStatus, type WhiteboardFileTransferOptions } from "./files";
import type { ExcalidrawImperativeAPI } from "./types";

type Options = Pick<WhiteboardFileTransferOptions, "uploadFile"> & {
  readonly excalidrawAPI: ExcalidrawImperativeAPI;
  readonly onSubmissionError?: (error: unknown) => void;
};

export class LocalImageUploads {
  readonly stored = new Set<string>();
  private readonly pending = new Map<string, AbortController>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly opts: Options,
    private readonly onStored: () => void,
  ) {}

  addStored(fileIds: Iterable<string>): void {
    for (const fileId of fileIds) this.stored.add(fileId);
  }

  upload(sceneId: string | null, sceneGeneration: string | null): void {
    const { excalidrawAPI, uploadFile } = this.opts;
    if (!sceneId || !uploadFile) return;

    const files = excalidrawAPI.getFiles();
    for (const element of excalidrawAPI.getSceneElements()) {
      if (element.type !== "image" || !element.fileId) continue;
      const { fileId } = element;
      const file = files[fileId];
      if (!file || this.hasHandled(fileId)) continue;

      const transfer = new AbortController();
      this.pending.set(fileId, transfer);
      void this.uploadImage(uploadFile, sceneId, sceneGeneration, fileId, file.dataURL, transfer);
    }
  }

  private hasHandled(fileId: string): boolean {
    return this.stored.has(fileId) || this.pending.has(fileId) || this.failed.has(fileId);
  }

  private async uploadImage(uploadFile: NonNullable<WhiteboardFileTransferOptions["uploadFile"]>, sceneId: string, sceneGeneration: string | null, fileId: string, dataURL: string, transfer: AbortController): Promise<void> {
    const { signal } = transfer;
    try {
      const { mimeType, bytes } = decodeWhiteboardImageDataURL(dataURL);
      const blob = new Blob([bytes], { type: mimeType });
      await uploadFile({ sceneId, ...(sceneGeneration ? { sceneGeneration } : {}), fileId, blob, signal });
      if (signal.aborted) return;
      this.stored.add(fileId);
      updateImageStatus(this.opts.excalidrawAPI, fileId, "saved");
      this.onStored();
    } catch (cause) {
      if (signal.aborted) return;
      this.failed.add(fileId);
      updateImageStatus(this.opts.excalidrawAPI, fileId, "error");
      this.opts.onSubmissionError?.(cause);
    } finally {
      if (this.pending.get(fileId) === transfer) this.pending.delete(fileId);
    }
  }

  stripUnstored(): void {
    const elements = this.opts.excalidrawAPI.getSceneElementsIncludingDeleted();
    const retained = retainStoredImages(elements, this.stored);
    if (retained.length === elements.length) return;
    this.opts.excalidrawAPI.updateScene({ elements: retained, captureUpdate: CaptureUpdateAction.NEVER });
  }

  reset(): void {
    for (const transfer of this.pending.values()) transfer.abort();
    this.pending.clear();
    this.failed.clear();
    this.stored.clear();
  }
}
