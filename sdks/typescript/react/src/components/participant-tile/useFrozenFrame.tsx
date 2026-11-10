import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** True while the call is reconnecting or has lost its connection: tiles hold their last picture instead of going blank. */
export const FrozenFramesContext = createContext(false);
export const useFramesFrozen = (): boolean => useContext(FrozenFramesContext);

/**
 * Copies the visible video frame onto a canvas at the moment the call drops. Safari blanks a video whose
 * track has ended, so the picture a person was looking at must be saved before that happens.
 */
export function useFrozenFrame(videoRef: RefObject<HTMLVideoElement | null>, frozen: boolean): { readonly node: ReactNode; readonly shown: boolean } {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [captured, setCaptured] = useState(false);
  useLayoutEffect(() => {
    if (!frozen) {
      setCaptured(false);
      return;
    }
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.srcObject || video.videoWidth === 0) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0);
    setCaptured(true);
  }, [frozen, videoRef]);
  return { node: <canvas ref={canvasRef} />, shown: frozen && captured };
}
