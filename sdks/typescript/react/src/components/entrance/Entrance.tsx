"use client";

import { useEffect, useState } from "react";
import type React from "react";

import type { ChalkTheme } from "../../theme";
import { EntranceSurface } from "./EntranceSurface";

export type EntranceSettings = {
  readonly displayName: string;
  readonly microphone: boolean;
  readonly camera: boolean;
};

export type EntranceProps = {
  readonly spaceName: string;
  readonly logoUrl?: string;
  readonly defaultDisplayName?: string;
  readonly defaults?: {
    readonly microphone?: boolean;
    readonly camera?: boolean;
  };
  readonly joining?: boolean;
  readonly error?: string;
  readonly theme?: ChalkTheme;
  readonly onJoin: (settings: EntranceSettings) => void | Promise<void>;
  readonly onCancel?: () => void;
};

export function Entrance({ spaceName, logoUrl, defaultDisplayName = "", defaults, joining = false, error, theme, onJoin, onCancel }: EntranceProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [microphone, setMicrophone] = useState(defaults?.microphone ?? true);
  const [camera, setCamera] = useState(defaults?.camera ?? true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia || (!microphone && !camera)) {
      setPreviewStream((current) => {
        stopTracks(current);
        return null;
      });
      return;
    }

    let cancelled = false;
    let requestedStream: MediaStream | null = null;
    void navigator.mediaDevices
      .getUserMedia({ audio: microphone, video: camera })
      .then((stream) => {
        requestedStream = stream;
        if (cancelled) {
          stopTracks(stream);
          return;
        }
        setPreviewError(null);
        setPreviewStream((current) => {
          stopTracks(current);
          return stream;
        });
      })
      .catch(() => {
        if (!cancelled) setPreviewError("Preview is unavailable. You can still enter with devices disabled.");
      });

    return () => {
      cancelled = true;
      stopTracks(requestedStream);
    };
  }, [camera, microphone]);

  useEffect(() => () => stopTracks(previewStream), [previewStream]);

  const submit = () => {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName || joining) return;
    void onJoin({ displayName: normalizedDisplayName, microphone, camera });
  };

  return (
    <EntranceSurface
      spaceName={spaceName}
      logoUrl={logoUrl}
      displayName={displayName}
      microphone={microphone}
      camera={camera}
      joining={joining}
      error={error}
      theme={theme}
      previewError={previewError}
      previewStream={previewStream}
      onDisplayNameChange={setDisplayName}
      onMicrophoneChange={setMicrophone}
      onCameraChange={setCamera}
      onSubmit={submit}
      onCancel={onCancel}
    />
  );
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
