import { ChalkWhiteboardV1Error, type ChalkWhiteboardV1Event, type ChalkWhiteboardV1Transport, type SpaceClient } from "@q9labsai/chalk-client";
import type { AnnotationTextMeasure } from "@q9labsai/chalk-screen-annotation";
import { annotationWhiteboardPlacement, createAnnotationWhiteboardImport, fromWireElement } from "@q9labsai/chalk-whiteboard/annotation";
import { CryptoDigestAlgorithm, digest, randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import type { ScreenAnnotationFrame } from "./model";

type Snapshot = Extract<ChalkWhiteboardV1Event, { type: "snapshot" }>;

export type NativeAnnotationBoard = {
  readonly space: SpaceClient;
  readonly transport: ChalkWhiteboardV1Transport;
};

export async function saveNativeAnnotationToBoard({ space, transport }: NativeAnnotationBoard, frame: ScreenAnnotationFrame<string>, measureText: AnnotationTextMeasure, isCurrent: () => boolean): Promise<void> {
  const sceneId = space.getSnapshot().whiteboard.engine.sceneId;
  const uploadFile = transport.files.uploadFile;
  if (!sceneId || !uploadFile) throw new Error("The board cannot save files.");
  function checkAccess() {
    const board = space.getSnapshot().whiteboard;
    if (!isCurrent() || !board.access.canDraw || board.engine.status !== "ready" || board.engine.sceneId !== sceneId || space.whiteboard.transport() !== transport) {
      throw new Error("The board or shared screen changed while saving.");
    }
  }

  checkAccess();
  let snapshot: Snapshot | undefined;
  const unsubscribe = transport.subscribe((event) => {
    if (event.type === "snapshot") snapshot = event;
  });
  try {
    if (!snapshot) await transport.requestSnapshot();
  } finally {
    unsubscribe();
  }
  checkAccess();
  if (!snapshot || snapshot.sceneId !== sceneId) throw new Error("The board changed while saving.");

  const elements = snapshot.elements.map(({ id, type, version, index, isDeleted, versionNonce, payload }) => fromWireElement({ id, type, version, index, is_deleted: isDeleted, version_nonce: versionNonce, payload }));
  const operation = createAnnotationWhiteboardImport({
    frame,
    sceneId,
    importId: randomUUID(),
    placement: annotationWhiteboardPlacement(elements, { x: 0, y: 0 }),
    measureText,
    encodeFrame: async (image) => {
      const file = new File(image);
      if (!file.exists || file.size <= 0 || file.size > 20 * 1024 * 1024) throw new Error("The shared frame is unavailable or too large.");
      return file.bytes();
    },
    uploadFrame: async ({ sceneId, fileId, png: bytes }) => {
      const hash = await digest(CryptoDigestAlgorithm.SHA256, bytes);
      const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      for (let attempt = 1; ; attempt++) {
        checkAccess();
        try {
          await uploadFile({ sceneId, fileId, bytes, sha256, mimeType: "image/png" });
          return;
        } catch (error) {
          if (!(error instanceof ChalkWhiteboardV1Error) || !error.recoverable || attempt === 3) throw error;
        }
      }
    },
    transport: {
      submitUpdate: (input) => {
        checkAccess();
        return transport.submitUpdate(input);
      },
    },
  });
  await operation.save();
}
