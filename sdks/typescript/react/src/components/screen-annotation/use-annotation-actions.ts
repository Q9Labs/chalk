import { captureAnnotationVideoFrame, type BakedExportProof } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationState, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import { useRef, useState, type RefObject } from "react";
import { canDraw, matchesTarget, targetOf, videoMatchesTrack, visibleMarks, type ScreenAnnotationActions, type ScreenAnnotationFrame } from "./model";

export function useAnnotationActions({
  client,
  state,
  actions,
  videoRef,
  track,
  actorId,
  allowExport,
  exportProof,
  bakedFrame,
}: {
  readonly client: ScreenAnnotationClient;
  readonly state: ScreenAnnotationState;
  readonly actions?: ScreenAnnotationActions;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly track: MediaStreamTrack;
  readonly actorId: string;
  readonly allowExport: boolean;
  readonly exportProof: BakedExportProof;
  readonly bakedFrame: RefObject<HTMLCanvasElement | null>;
}) {
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const boardRetry = useRef<{ frame: ScreenAnnotationFrame; target: ScreenAnnotationTarget; action: NonNullable<ScreenAnnotationActions["saveToWhiteboard"]> } | null>(null);
  const target = targetOf(state);
  const { saveToWhiteboard, downloadPng } = actions ?? {};

  const onError = (message: string) => setFeedback({ message, error: true });

  const command = async (command: ScreenAnnotationCommand) => {
    setFeedback(null);
    try {
      const result = await client.dispatch(target, command);
      if (result.kind !== "accepted" && matchesTarget(client, target)) onError("The annotation action could not be applied.");
    } catch {
      if (matchesTarget(client, target)) onError("The annotation action could not be applied.");
    }
  };
  function currentShare(video: HTMLVideoElement | null): ScreenAnnotationState | null {
    const live = matchesTarget(client, target);
    return live && video && videoRef.current === video && videoMatchesTrack(video, track) && canDraw(live, actorId) ? live : null;
  }
  function captureFrame(video: HTMLVideoElement, live: ScreenAnnotationState): ScreenAnnotationFrame {
    const { layer, marks, paused } = live;
    const scene = { publicationId: layer.publication_id, marks: layer.burned_in ? [] : marks, paused, sharerId: layer.sharer_id, nowMs: client.serverNowMs() };
    return captureAnnotationVideoFrame(video, scene, layer.burned_in ? bakedFrame.current : null);
  }
  const exportFrame = async (action: NonNullable<ScreenAnnotationActions["saveToWhiteboard"]>, toBoard: boolean) => {
    if (saving.current) return;
    const video = videoRef.current;
    let live = currentShare(video);
    if (!live || !video) return;
    saving.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const retry = toBoard && boardRetry.current?.action === action && boardRetry.current.target.fence === target.fence ? boardRetry.current : null;
      if (!retry && live.layer.burned_in) {
        await exportProof.wait(visibleMarks(live, client.serverNowMs()).map(({ draft }) => draft.mark_id));
        live = currentShare(video);
        if (!live) return;
      }
      const frame = retry?.frame ?? captureFrame(video, live);
      if (toBoard) boardRetry.current = { frame, action, target };
      await action(frame);
      if (toBoard) boardRetry.current = null;
      setFeedback({ message: toBoard ? "Frame saved to the board." : "PNG downloaded.", error: false });
    } catch {
      onError("The annotated frame could not be saved.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return {
    feedback,
    busy,
    onError,
    command,
    saveFrame: allowExport && saveToWhiteboard ? () => void exportFrame(saveToWhiteboard, true) : undefined,
    downloadFrame: allowExport && downloadPng ? () => void exportFrame(downloadPng, false) : undefined,
  };
}
