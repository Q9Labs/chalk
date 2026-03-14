import { mediaDevices, type MediaStream as NativeMediaStream } from "@cloudflare/react-native-webrtc";
import { useEffect, useRef, useState } from "react";

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

  useEffect(() => {
    let active = true;
    let nextStream: NativeMediaStream | null = null;

    if (!enabled) {
      stopPreviewTracks(activeStreamRef.current);
      activeStreamRef.current = null;
      setPreviewStream(null);
      setPreviewError(null);
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
  }, [enabled]);

  return { previewStream, previewError };
}
