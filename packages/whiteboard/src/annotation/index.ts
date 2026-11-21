import type { FileId } from "@excalidraw/excalidraw/element/types";
import type { ChalkWhiteboardV1Commit, ChalkWhiteboardV1Element, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import type { AnnotationTextMeasure, ScreenAnnotationFrame } from "@q9labsai/chalk-screen-annotation";

import { toFittedWireElement } from "../collab/wire";
import { annotationBoardElements, type AnnotationWhiteboardPlacement } from "./elements";

export { annotationWhiteboardPlacement } from "./elements";
export type { AnnotationWhiteboardPlacement } from "./elements";

export type AnnotationWhiteboardImportOptions<Image> = {
  readonly frame: ScreenAnnotationFrame<Image>;
  readonly sceneId: string;
  readonly placement: AnnotationWhiteboardPlacement;
  readonly measureText: AnnotationTextMeasure;
  readonly transport: Pick<ChalkWhiteboardV1Transport, "submitUpdate">;
  readonly encodeFrame: (image: Image) => Promise<Blob>;
  /**
   * Publish a ready asset under the supplied ID in this exact board scene. Repeating the same
   * request after an uncertain upload must succeed without replacing a different asset.
   */
  readonly uploadFrame: (input: { readonly sceneId: string; readonly fileId: string; readonly png: Blob }) => Promise<void>;
  readonly importId?: string;
};

export type AnnotationWhiteboardImport = {
  readonly importId: string;
  /** Retry on this object; creating a new one is a separate board insertion. */
  save(): Promise<ChalkWhiteboardV1Commit>;
};

export function createAnnotationWhiteboardImport<Image>(options: AnnotationWhiteboardImportOptions<Image>): AnnotationWhiteboardImport {
  const { frame, sceneId, placement, measureText, transport, encodeFrame, uploadFrame } = options;
  const importId = options.importId ?? crypto.randomUUID();
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(importId)) throw new TypeError("Expected a lowercase annotation import UUID");
  const fileId = `annotation-${importId}` as FileId;
  const elements: readonly ChalkWhiteboardV1Element[] = annotationBoardElements(frame, placement, importId, fileId, measureText).map((element) => {
    const { id, type, version, index, version_nonce, is_deleted, payload } = toFittedWireElement(element);
    return { id, type, version, index, versionNonce: version_nonce, isDeleted: is_deleted, payload };
  });

  let png: Blob | undefined;
  let uploaded = false;
  let committed: ChalkWhiteboardV1Commit | undefined;
  let pending: Promise<ChalkWhiteboardV1Commit> | undefined;

  async function save(): Promise<ChalkWhiteboardV1Commit> {
    if (!uploaded) {
      png ??= await encodeFrame(frame.image);
      await uploadFrame({ sceneId, fileId, png });
      uploaded = true;
      png = undefined;
    }
    committed = await transport.submitUpdate({ sceneId, syncAll: false, elements });
    return committed;
  }

  return {
    importId,
    save() {
      if (committed) return Promise.resolve(committed);
      pending ??= save().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
