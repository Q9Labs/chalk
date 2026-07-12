import { mediaDevices, type NativeMediaStream } from "../media/realtimekit/native-webrtc";
import { useEffect, useRef, useState } from "react";
import { getIosSimulatorVideoMessage, isIosSimulator } from "../utils/ios-simulator";

export interface UsePreJoinPreviewReturn {
  previewStream: NativeMediaStream | null;
  previewError: string | null;
}

function stopPreviewTracks(stream: NativeMediaStream | null): void {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Best effort only.
    }
  });
}

export function usePreJoinPreview(enabled: boolean): UsePreJoinPreviewReturn {
  const [previewStream, setPreviewStream] = useState<NativeMediaStream | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const activeStreamRef = useRef<NativeMediaStream | null>(null);
  const simulatorVideoDisabled = isIosSimulator();

  useEffect(() => {
    let active = true;
    let nextStream: NativeMediaStream | null = null;

    if (!enabled || simulatorVideoDisabled) {
      stopPreviewTracks(activeStreamRef.current);
      activeStreamRef.current = null;
      setPreviewStream(null);
      setPreviewError(enabled && simulatorVideoDisabled ? getIosSimulatorVideoMessage() : null);
      return undefined;
    }

    void mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
        },
      })
      .then((stream: NativeMediaStream) => {
        const videoTrack = stream.getVideoTracks?.()[0] ?? null;
        if (!active) {
          stopPreviewTracks(stream);
          return;
        }

        if (!videoTrack) {
          stopPreviewTracks(stream);
          setPreviewStream(null);
          setPreviewError("No camera track available");
          return;
        }

        stopPreviewTracks(activeStreamRef.current);
        activeStreamRef.current = stream;
        nextStream = stream;
        setPreviewStream(stream);
        setPreviewError(null);
      })
      .catch((cause: unknown) => {
        if (!active) {
          return;
        }

        setPreviewStream(null);
        setPreviewError(cause instanceof Error ? cause.message : "Unable to start camera preview");
      });

    return () => {
      active = false;
      setPreviewStream(null);
      stopPreviewTracks(nextStream);
      if (activeStreamRef.current === nextStream) {
        activeStreamRef.current = null;
      }
    };
  }, [enabled, simulatorVideoDisabled]);

  return { previewStream, previewError };
}
