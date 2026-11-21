import type { ChalkWhiteboardV1Event, ChalkWhiteboardV1Transport, SpaceClient } from "@q9labsai/chalk-client";
import { canvasAnnotationTextMeasure, encodeAnnotationCanvasPng } from "@q9labsai/chalk-screen-annotation";
import type { AnnotationWhiteboardImport } from "@q9labsai/chalk-whiteboard/annotation";
import { toWhiteboardWireElement } from "../../whiteboard/wire-adapters";
import { loadAnnotationFont } from "./font";
import type { ScreenAnnotationFrame, ScreenAnnotationSetup } from "./model";

type Snapshot = Extract<ChalkWhiteboardV1Event, { type: "snapshot" }>;
type Upload = NonNullable<ScreenAnnotationSetup["uploadBoardFrame"]>;

export function saveAnnotationToBoard(client: SpaceClient, transport: ChalkWhiteboardV1Transport, uploadFrame: Upload, fontUrl?: string) {
  const imports = new WeakMap<ScreenAnnotationFrame, { sceneId: string; operation: AnnotationWhiteboardImport }>();
  const requireAccess = (sceneId?: string) => {
    const board = client.getSnapshot().whiteboard;
    if (!board.access.canDraw || board.engine.status !== "ready" || !board.engine.sceneId || (sceneId && board.engine.sceneId !== sceneId)) {
      throw new Error("The board is no longer available for this save.");
    }
    return board.engine.sceneId;
  };

  return async (frame: ScreenAnnotationFrame): Promise<void> => {
    const pending = imports.get(frame);
    const sceneId = requireAccess(pending?.sceneId);
    if (pending) {
      await pending.operation.save();
      return;
    }
    const [current, whiteboard, annotation] = await Promise.all([readScene(transport, sceneId), import("@q9labsai/chalk-whiteboard"), import("@q9labsai/chalk-whiteboard/annotation"), loadAnnotationFont(frame.image.ownerDocument, fontUrl)]);
    requireAccess(sceneId);
    const context = frame.image.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable.");
    const elements = current.elements.map((element) => whiteboard.fromWireElement(toWhiteboardWireElement(element)));
    const operation = annotation.createAnnotationWhiteboardImport({
      frame,
      sceneId,
      placement: annotation.annotationWhiteboardPlacement(elements, { x: 0, y: 0 }),
      measureText: canvasAnnotationTextMeasure(context),
      encodeFrame: encodeAnnotationCanvasPng,
      uploadFrame: (input) => {
        requireAccess(sceneId);
        return uploadFrame(input);
      },
      transport: {
        submitUpdate: (input) => {
          requireAccess(sceneId);
          return transport.submitUpdate(input);
        },
      },
    });
    imports.set(frame, { sceneId, operation });
    await operation.save();
  };
}

async function readScene(transport: ChalkWhiteboardV1Transport, sceneId: string): Promise<Snapshot> {
  let snapshot: Snapshot | undefined;
  const unsubscribe = transport.subscribe((event) => {
    if (event.type === "snapshot") snapshot = event;
  });
  try {
    if (!snapshot) await transport.requestSnapshot();
    if (!snapshot || snapshot.sceneId !== sceneId) throw new Error("The board changed while saving.");
    return snapshot;
  } finally {
    unsubscribe();
  }
}
