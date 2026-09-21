"use client";

import { fromWireElement, type BinaryFiles, type ExcalidrawImperativeAPI } from "@q9labsai/chalk-whiteboard";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../../utils/cn";
import { WhiteboardView } from "./WhiteboardView";
import { parseRecordingWhiteboardStateV1, recordingWhiteboardFileAssetId, recordingWhiteboardFileIds, recordingWhiteboardSceneAppState, type RecordingWhiteboardStateV1 } from "./recording-whiteboard-state";

export { loadRecordingWhiteboardFiles, parseRecordingWhiteboardStateV1, recordingWhiteboardBinaryFile, recordingWhiteboardFileAssetId, recordingWhiteboardFileIds } from "./recording-whiteboard-state";
export type { RecordingWhiteboardBinaryFileInput, RecordingWhiteboardFileReference, RecordingWhiteboardFileResolver, RecordingWhiteboardStateV1 } from "./recording-whiteboard-state";

export interface RecordingWhiteboardViewProps {
  /** The untrusted JSON value resolved from the frame's stateAssetId. */
  readonly state: unknown;
  /** Optional file data resolved and verified by the host for file-backed elements. */
  readonly files?: BinaryFiles;
  readonly expectedSceneId?: string;
  readonly expectedRevision?: number;
  readonly theme?: "light" | "dark";
  readonly excalidrawCssPath?: string;
  readonly onLoadError?: (error: Error) => void;
  /** Fires after the frozen scene is installed and fitted in its viewport. */
  readonly onPresented?: (state: RecordingWhiteboardStateV1) => void;
  readonly className?: string;
}

interface ReadyWhiteboard {
  readonly api: ExcalidrawImperativeAPI;
  readonly defaultViewBackgroundColor: string;
}

export function RecordingWhiteboardView({ state: stateValue, files, expectedSceneId, expectedRevision, theme, excalidrawCssPath, onLoadError, onPresented, className }: RecordingWhiteboardViewProps): React.JSX.Element {
  const state = useMemo(() => parseRecordingWhiteboardStateV1(stateValue), [stateValue]);
  const elements = useMemo(() => state.elements.map(fromWireElement), [state.elements]);
  const resolvedTheme = theme ?? "light";
  const [ready, setReady] = useState<ReadyWhiteboard | null>(null);
  const [presentedState, setPresentedState] = useState<RecordingWhiteboardStateV1 | null>(null);
  const handleReady = useCallback((api: ExcalidrawImperativeAPI) => setReady(Object.freeze({ api, defaultViewBackgroundColor: api.getAppState().viewBackgroundColor })), []);
  const requiredFileIds = recordingWhiteboardFileIds(state);

  if (expectedSceneId !== undefined && state.sceneId !== expectedSceneId) throw new TypeError("recording whiteboard scene does not match the presentation frame");
  if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new TypeError("recording whiteboard revision does not match the presentation frame");
  for (const fileId of requiredFileIds) {
    if (!Object.hasOwn(files ?? {}, fileId)) throw new TypeError(`recording whiteboard file is missing: ${recordingWhiteboardFileAssetId(fileId)}`);
  }

  useEffect(() => {
    if (!ready) return;
    setPresentedState(null);
    const installScene = (): void => {
      if (files) ready.api.addFiles(Object.values(files));
      ready.api.updateScene({ elements, appState: recordingWhiteboardSceneAppState(state, ready.defaultViewBackgroundColor), captureUpdate: "NEVER" });
    };
    installScene();

    const visibleElements = elements.filter((element) => !element.isDeleted);
    let presentedFrameRef: number | undefined;
    const reconcileFrame = requestAnimationFrame(() => {
      installScene();
      if (visibleElements.length > 0) ready.api.scrollToContent(visibleElements, { fitToContent: true, animate: false, viewportZoomFactor: 0.9 });
      const presentedFrame = requestAnimationFrame(() => setPresentedState(state));
      presentedFrameRef = presentedFrame;
    });
    return () => {
      cancelAnimationFrame(reconcileFrame);
      if (presentedFrameRef !== undefined) cancelAnimationFrame(presentedFrameRef);
    };
  }, [elements, files, ready, state]);

  useEffect(() => {
    if (presentedState !== state || onPresented === undefined) return;
    onPresented(state);
  }, [onPresented, presentedState, state]);

  return <WhiteboardView canDraw={false} className={cn("h-full w-full !min-h-0 !border-0", className)} excalidrawCssPath={excalidrawCssPath} onExcalidrawApiReady={handleReady} onLoadError={onLoadError} theme={resolvedTheme} />;
}

RecordingWhiteboardView.displayName = "RecordingWhiteboardView";
