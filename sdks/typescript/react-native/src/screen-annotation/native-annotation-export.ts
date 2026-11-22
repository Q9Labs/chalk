import type { ScreenAnnotationClient, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import type { RefObject } from "react";
import type { AnnotationCanvasHandle } from "./AnnotationCanvas";
import { shareAnnotationPng } from "./export-native-png";
import { hasTarget, matchLayer, visibleCommittedMarks, type ScreenAnnotationActions, type ScreenAnnotationSource } from "./model";

type ExportAction = NonNullable<ScreenAnnotationActions["downloadPng"]>;

export function nativeAnnotationExport({
  client,
  publicationId,
  source,
  target,
  actions,
  canSave,
  reportError,
  canvas,
}: {
  readonly client: ScreenAnnotationClient;
  readonly publicationId: string;
  readonly source: ScreenAnnotationSource;
  readonly target: ScreenAnnotationTarget;
  readonly actions?: ScreenAnnotationActions;
  readonly canSave?: boolean;
  readonly reportError?: (message: string) => void;
  readonly canvas: RefObject<AnnotationCanvasHandle | null>;
}) {
  async function exportFrame(action: ExportAction) {
    const live = matchLayer(client, publicationId);
    if (!source.captureFrame || !hasTarget(live, target)) return;
    const at = client.serverNowMs();
    const marks = visibleCommittedMarks(live, at);
    try {
      const frame = await source.captureFrame();
      if (frame === null) {
        reportError?.("Wait for the shared video to resume before saving a frame.");
        return;
      }
      try {
        await action({ publicationId, size: source.size, image: frame.image, marks, nowMs: at });
      } finally {
        frame.release?.();
      }
    } catch {
      reportError?.("Couldn’t save the marked frame.");
    }
  }

  const save = canSave && actions?.saveToWhiteboard && source.captureFrame ? actions.saveToWhiteboard : null;
  const download: ExportAction | null = source.captureFrame
    ? (actions?.downloadPng ??
      (async ({ image, ...frame }) => {
        if (!canvas.current || typeof image !== "string") throw new Error("No native frame");
        await shareAnnotationPng(await canvas.current.png({ ...frame, image }));
      }))
    : null;
  return { save, download, exportFrame };
}
