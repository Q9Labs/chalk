"use client";

import { useEffect, useState } from "react";
import type React from "react";

import type { ChalkTheme } from "../../theme";
import { EntranceSurface } from "./EntranceSurface";
import type { EntranceDevice, EntranceDeviceOptions } from "./types";

export type { EntranceDevice, EntranceDeviceOptions } from "./types";

export type EntranceSettings = {
  readonly displayName: string;
  readonly microphone: boolean;
  readonly camera: boolean;
  readonly audioInputDeviceId?: string;
  readonly videoInputDeviceId?: string;
  readonly audioOutputDeviceId?: string;
};

export type EntranceProps = EntranceDeviceOptions & {
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
  readonly generatedAvatars?: boolean;
  readonly onJoin: (settings: EntranceSettings) => void | Promise<void>;
  readonly onCancel?: () => void;
};

export function Entrance({
  spaceName,
  logoUrl,
  defaultDisplayName = "",
  defaults,
  joining = false,
  error,
  theme,
  generatedAvatars = true,
  onJoin,
  onCancel,
  audioInputDevices,
  videoInputDevices,
  audioOutputDevices,
  selectedAudioInput: selectedAudioInputProp,
  selectedVideoInput: selectedVideoInputProp,
  selectedAudioOutput: selectedAudioOutputProp,
  onAudioInputChange,
  onVideoInputChange,
  onAudioOutputChange,
}: EntranceProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [microphone, setMicrophone] = useState(defaults?.microphone ?? true);
  const [camera, setCamera] = useState(defaults?.camera ?? true);
  const [selectedAudioInput, setSelectedAudioInput] = useState(selectedAudioInputProp ?? "");
  const [selectedVideoInput, setSelectedVideoInput] = useState(selectedVideoInputProp ?? "");
  const [selectedAudioOutput, setSelectedAudioOutput] = useState(selectedAudioOutputProp ?? "");
  const [enumeratedDevices, setEnumeratedDevices] = useState<DeviceLists>({ audioInputDevices: [], videoInputDevices: [], audioOutputDevices: [] });
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (selectedAudioInputProp !== undefined) setSelectedAudioInput(selectedAudioInputProp ?? "");
  }, [selectedAudioInputProp]);

  useEffect(() => {
    if (selectedVideoInputProp !== undefined) setSelectedVideoInput(selectedVideoInputProp ?? "");
  }, [selectedVideoInputProp]);

  useEffect(() => {
    if (selectedAudioOutputProp !== undefined) setSelectedAudioOutput(selectedAudioOutputProp ?? "");
  }, [selectedAudioOutputProp]);

  const hasMissingDeviceList = audioInputDevices === undefined || videoInputDevices === undefined || audioOutputDevices === undefined;
  useEffect(() => {
    if (!hasMissingDeviceList || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (cancelled) return;
        setEnumeratedDevices({
          audioInputDevices: devicesOfKind(devices, "audioinput"),
          videoInputDevices: devicesOfKind(devices, "videoinput"),
          audioOutputDevices: devicesOfKind(devices, "audiooutput"),
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasMissingDeviceList]);

  const effectiveAudioInputDevices = audioInputDevices ?? enumeratedDevices.audioInputDevices;
  const effectiveVideoInputDevices = videoInputDevices ?? enumeratedDevices.videoInputDevices;
  const effectiveAudioOutputDevices = audioOutputDevices ?? enumeratedDevices.audioOutputDevices;

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
      .getUserMedia({ audio: captureConstraint(microphone, selectedAudioInput), video: captureConstraint(camera, selectedVideoInput) })
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
  }, [camera, microphone, selectedAudioInput, selectedVideoInput]);

  useEffect(() => () => stopTracks(previewStream), [previewStream]);

  const submit = () => {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName || joining) return;
    void onJoin({
      displayName: normalizedDisplayName,
      microphone,
      camera,
      ...(selectedAudioInput ? { audioInputDeviceId: selectedAudioInput } : {}),
      ...(selectedVideoInput ? { videoInputDeviceId: selectedVideoInput } : {}),
      ...(selectedAudioOutput ? { audioOutputDeviceId: selectedAudioOutput } : {}),
    });
  };

  const selectAudioInput = (deviceId: string) => {
    setSelectedAudioInput(deviceId);
    void onAudioInputChange?.(deviceId);
  };
  const selectVideoInput = (deviceId: string) => {
    setSelectedVideoInput(deviceId);
    void onVideoInputChange?.(deviceId);
  };
  const selectAudioOutput = (deviceId: string) => {
    setSelectedAudioOutput(deviceId);
    void onAudioOutputChange?.(deviceId);
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
      generatedAvatars={generatedAvatars}
      previewError={previewError}
      previewStream={previewStream}
      onDisplayNameChange={setDisplayName}
      onMicrophoneChange={setMicrophone}
      onCameraChange={setCamera}
      audioInputDevices={effectiveAudioInputDevices}
      videoInputDevices={effectiveVideoInputDevices}
      audioOutputDevices={effectiveAudioOutputDevices}
      selectedAudioInput={selectedAudioInput}
      selectedVideoInput={selectedVideoInput}
      selectedAudioOutput={selectedAudioOutput}
      onAudioInputChange={selectAudioInput}
      onVideoInputChange={selectVideoInput}
      onAudioOutputChange={selectAudioOutput}
      onSubmit={submit}
      onCancel={onCancel}
    />
  );
}

type DeviceLists = {
  readonly audioInputDevices: readonly EntranceDevice[];
  readonly videoInputDevices: readonly EntranceDevice[];
  readonly audioOutputDevices: readonly EntranceDevice[];
};

function devicesOfKind(devices: readonly MediaDeviceInfo[], kind: MediaDeviceKind): EntranceDevice[] {
  return devices.filter((device) => device.kind === kind).map(({ deviceId, label }) => ({ deviceId, label }));
}

function captureConstraint(enabled: boolean, deviceId: string): boolean | MediaTrackConstraints {
  if (!enabled) return false;
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
