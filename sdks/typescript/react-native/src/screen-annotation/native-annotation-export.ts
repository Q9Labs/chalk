import type { ScreenAnnotationClient, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import type { BakedExportProof } from "@q9labsai/chalk-screen-annotation";
import type { RefObject } from "react";
import type { AnnotationCanvasHandle } from "./AnnotationCanvas";
import { shareAnnotationPng } from "./export-native-png";
import { saveNativeAnnotationToBoard, type NativeAnnotationBoard } from "./save-to-board";
import { hasTarget, matchLayer, visibleCommittedMarks, type ScreenAnnotationActions, type ScreenAnnotationSource } from "./model";

type ExportAction = NonNullable<ScreenAnnotationActions["downloadPng"]>;

export function nativeAnnotationExport({
  client,
  publicationId,
  source,
  target,
  actions,
  boardSave,
  canSave,
  reportError,
  canvas,
  exporting,
  exportProof,
  setWaitingForInk,
}: {
  readonly client: ScreenAnnotationClient;
  readonly publicationId: string;
  readonly source: ScreenAnnotationSource;
  readonly target: ScreenAnnotationTarget;
  readonly actions?: ScreenAnnotationActions;
  readonly boardSave?: NativeAnnotationBoard;
  readonly canSave?: boolean;
  readonly reportError?: (message: string) => void;
  readonly canvas: RefObject<AnnotationCanvasHandle | null>;
  readonly exporting: RefObject<boolean>;
  readonly exportProof: BakedExportProof;
  readonly setWaitingForInk: (waiting: boolean) => void;
}) {
  async function exportFrame(action: ExportAction) {
    let live = matchLayer(client, publicationId);
    if (exporting.current || !source.captureFrame || !hasTarget(live, target)) return;
    exporting.current = true;
    try {
      if (live.layer.burned_in) {
        const ids = visibleCommittedMarks(live, client.serverNowMs()).map(({ draft }) => draft.mark_id);
        setWaitingForInk(true);
        try {
          await exportProof.wait(ids);
        } finally {
          setWaitingForInk(false);
        }
        live = matchLayer(client, publicationId);
        if (!hasTarget(live, target)) return;
      }
      const at = client.serverNowMs();
      const marks = live.layer.burned_in ? [] : visibleCommittedMarks(live, at);
      const frame = await source.captureFrame();
      if (frame === null) {
        reportError?.("Wait for the shared video to resume before saving a frame.");
        return;
      }
      try {
        if (!hasTarget(matchLayer(client, publicationId), target)) return;
        await action({ publicationId, size: source.size, image: frame.image, marks, nowMs: at });
      } finally {
        frame.release?.();
      }
    } catch {
      reportError?.("Couldn’t save the marked frame.");
    } finally {
      exporting.current = false;
    }
  }

  const save: ExportAction | null =
    canSave && source.captureFrame
      ? (actions?.saveToWhiteboard ??
        (boardSave
          ? async (marked) => {
              const { image, ...frame } = marked;
              if (typeof image !== "string" || !canvas.current) throw new Error("No native frame");
              const measureText = await canvas.current.measure({ ...frame, image });
              await saveNativeAnnotationToBoard(boardSave, { ...frame, image }, measureText, () => hasTarget(matchLayer(client, publicationId), target));
            }
          : null))
      : null;
  const download: ExportAction | null = source.captureFrame
    ? (actions?.downloadPng ??
      (async (marked) => {
        const { image, ...frame } = marked;
        if (!canvas.current || typeof image !== "string") throw new Error("No native frame");
        await shareAnnotationPng(await canvas.current.png({ ...frame, image }));
      }))
    : null;
  return { save, download, exportFrame };
}
