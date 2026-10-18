"use client";
import { useEffect, useState } from "react";
import type React from "react";
import type { SpaceClient } from "@q9labsai/chalk-client";
import { CommandErrorAlert } from "../components/composite/CommandErrorAlert";
import type { SpaceLayout } from "../components/chalk/Chalk";
import { EntranceSurface } from "../components/entrance/EntranceSurface";
import type { EntranceProps, EntranceSettings } from "../components/entrance/Entrance";
import { SpaceView, type SpacePanel, type SpaceViewProps } from "../components/space-view/SpaceView";
import { ChalkProvider } from "../bindings/context";
import { createPreviewClient } from "./preview-client";
/**
 * DEV-only adapter for the URL-addressable SDK gallery. It deliberately lives
 * outside every package entrypoint so preview state cannot become product API.
 */
export type PreviewEntranceProps = Omit<EntranceProps, "defaults"> & {
  readonly microphone?: boolean;
  readonly camera?: boolean;
  readonly previewError?: string | null;
  readonly previewStream?: MediaStream | null;
};
/**
 * Permission-free fixture adapter. It uses the canonical Entrance surface but
 * never mounts production media acquisition effects, so URL-driven gallery
 * states remain deterministic in browsers, tests, and documentation embeds.
 */
export function PreviewEntrance({
  microphone = true,
  camera = true,
  defaultDisplayName = "",
  joining = false,
  error,
  previewError,
  previewStream = null,
  onJoin,
  onCancel,
  spaceName,
  logoUrl,
  theme,
  audioInputDevices,
  videoInputDevices,
  audioOutputDevices,
  selectedAudioInput,
  selectedVideoInput,
  selectedAudioOutput,
  onAudioInputChange,
  onVideoInputChange,
  onAudioOutputChange,
}: PreviewEntranceProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(microphone);
  const [cameraEnabled, setCameraEnabled] = useState(camera);
  const [audioInputDeviceId, setAudioInputDeviceId] = useState(selectedAudioInput ?? "");
  const [videoInputDeviceId, setVideoInputDeviceId] = useState(selectedVideoInput ?? "");
  const [audioOutputDeviceId, setAudioOutputDeviceId] = useState(selectedAudioOutput ?? "");
  useEffect(() => setDisplayName(defaultDisplayName), [defaultDisplayName]);
  useEffect(() => setMicrophoneEnabled(microphone), [microphone]);
  useEffect(() => setCameraEnabled(camera), [camera]);
  useEffect(() => setAudioInputDeviceId(selectedAudioInput ?? ""), [selectedAudioInput]);
  useEffect(() => setVideoInputDeviceId(selectedVideoInput ?? ""), [selectedVideoInput]);
  useEffect(() => setAudioOutputDeviceId(selectedAudioOutput ?? ""), [selectedAudioOutput]);
  const selectAudioInput = (deviceId: string) => {
    setAudioInputDeviceId(deviceId);
    void onAudioInputChange?.(deviceId);
  };
  const selectVideoInput = (deviceId: string) => {
    setVideoInputDeviceId(deviceId);
    void onVideoInputChange?.(deviceId);
  };
  const selectAudioOutput = (deviceId: string) => {
    setAudioOutputDeviceId(deviceId);
    void onAudioOutputChange?.(deviceId);
  };
  const onSubmit = () => {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName || joining) return;
    void onJoin({
      displayName: normalizedDisplayName,
      microphone: microphoneEnabled,
      camera: cameraEnabled,
      ...(audioInputDeviceId ? { audioInputDeviceId } : {}),
      ...(videoInputDeviceId ? { videoInputDeviceId } : {}),
      ...(audioOutputDeviceId ? { audioOutputDeviceId } : {}),
    });
  };
  return (
    <EntranceSurface
      spaceName={spaceName}
      logoUrl={logoUrl}
      displayName={displayName}
      microphone={microphoneEnabled}
      camera={cameraEnabled}
      joining={joining}
      error={error}
      theme={theme}
      previewError={previewError}
      previewStream={previewStream}
      audioInputDevices={audioInputDevices}
      videoInputDevices={videoInputDevices}
      audioOutputDevices={audioOutputDevices}
      selectedAudioInput={audioInputDeviceId}
      selectedVideoInput={videoInputDeviceId}
      selectedAudioOutput={audioOutputDeviceId}
      onDisplayNameChange={setDisplayName}
      onMicrophoneChange={setMicrophoneEnabled}
      onCameraChange={setCameraEnabled}
      onAudioInputChange={selectAudioInput}
      onVideoInputChange={selectVideoInput}
      onAudioOutputChange={selectAudioOutput}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
/** The gallery supplies all state and commands; the production Chalk wrapper is never involved. */
export type PreviewSpaceViewProps = SpaceViewProps & {
  readonly client?: SpaceClient;
};
export function PreviewSpaceView({ client, ...props }: PreviewSpaceViewProps): React.JSX.Element {
  const [fallbackClient] = useState(() => createPreviewClient());
  return (
    <ChalkProvider client={client ?? fallbackClient}>
      <SpaceView {...props} />
    </ChalkProvider>
  );
}
export function PreviewJoiningScreen({ displayName, message, supportingMessages = [] }: { readonly displayName?: string; readonly message: string; readonly supportingMessages?: readonly string[] }): React.JSX.Element {
  return (
    <main data-chalk className="chalk-root grid min-h-screen place-items-center bg-[var(--chalk-canvas)] p-6 text-center text-[var(--chalk-text)]">
      <div className="grid max-w-sm gap-3 justify-items-center">
        <p className="text-sm font-semibold" role="status">
          {message}
        </p>
        {displayName ? <p className="text-xs text-[var(--chalk-muted-text)]">Preparing for {displayName}</p> : null}
        {supportingMessages.map((supportingMessage) => (
          <p key={supportingMessage} className="text-xs text-[var(--chalk-muted-text)]">
            {supportingMessage}
          </p>
        ))}
      </div>
    </main>
  );
}
export { CommandErrorAlert };
export type { EntranceSettings, SpaceLayout, SpacePanel, SpaceViewProps };
