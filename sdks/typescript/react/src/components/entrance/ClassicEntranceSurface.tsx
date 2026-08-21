"use client";

import { useEffect, useRef } from "react";
import type React from "react";

import { chalkThemeStyle } from "../../theme";
import { LogoSource } from "../logo/LogoSource";
import { getThemeMode } from "../theme";
import { EntranceDeviceControls } from "./EntranceDeviceControls";
import { EntranceParticipantPreview } from "./EntranceParticipantPreview";
import type { EntranceSurfaceProps } from "./EntranceSurface";

/**
 * Internal presentational surface shared by production Entrance and the
 * permission-free SDK preview fixture. It deliberately owns no media access.
 */
export function ClassicEntranceSurface({
  spaceName,
  logoUrl,
  displayName,
  microphone,
  camera,
  joining,
  error,
  theme,
  previewError,
  previewStream = null,
  generatedAvatars = true,
  onDisplayNameChange,
  onMicrophoneChange,
  onCameraChange,
  onSubmit,
  onCancel,
  audioInputDevices,
  videoInputDevices,
  audioOutputDevices,
  selectedAudioInput,
  selectedVideoInput,
  selectedAudioOutput,
  onAudioInputChange,
  onVideoInputChange,
  onAudioOutputChange,
}: EntranceSurfaceProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = previewStream;
    return () => {
      if (videoRef.current?.srcObject === previewStream) videoRef.current.srcObject = null;
    };
  }, [previewStream]);

  const hasVideoPreview = camera && Boolean(previewStream?.getVideoTracks().length);
  const colorScheme = theme?.palette ? getThemeMode(theme.palette) : theme?.colorScheme === "dark" ? "dark" : "light";

  return (
    <main
      data-chalk
      data-chalk-skin="classic"
      data-chalk-theme={colorScheme}
      data-chalk-palette={theme?.palette}
      data-chalk-texture={theme?.texture}
      aria-busy={joining}
      style={chalkThemeStyle(theme, colorScheme)}
      className="chalk-root chalk-textured-surface relative grid h-full min-h-0 w-full place-items-center overflow-auto bg-[var(--chalk-canvas)] p-4 text-[var(--chalk-text)]"
    >
      <section className="grid w-full max-w-5xl max-h-full overflow-hidden overflow-y-auto rounded-lg border border-[var(--chalk-line)] bg-[var(--chalk-surface)] shadow-[var(--chalk-shadow)] lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="border-b border-[var(--chalk-line)] p-5 lg:border-r lg:border-b-0 lg:p-6">
          <header className="mb-5 flex items-center gap-3">
            <LogoSource className="h-auto w-28" height={32} logoUrl={logoUrl} />
            <span className="truncate text-sm text-[var(--chalk-muted-text)]">{spaceName}</span>
          </header>
          <div className="relative aspect-video min-h-[15rem] overflow-hidden rounded-md border border-[var(--chalk-line)] bg-[var(--chalk-stage)] lg:aspect-[4/3]">
            <video ref={videoRef} autoPlay playsInline muted className={hasVideoPreview ? "h-full w-full -scale-x-100 object-cover" : "hidden"} />
            {!hasVideoPreview ? <EntranceParticipantPreview displayName={displayName} microphone={microphone} generatedAvatars={generatedAvatars} /> : null}
            {hasVideoPreview ? <span className="absolute bottom-3 left-3 rounded bg-[var(--chalk-app-text,var(--chalk-text))] px-2 py-1 text-xs text-[var(--chalk-app-canvas,var(--chalk-accent-text))]">{displayName.trim() || "You"}</span> : null}
          </div>
        </div>
        <div className="flex flex-col justify-center p-6">
          <h1 className="text-3xl font-semibold">{joining ? "Requesting access" : "Enter this Space"}</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--chalk-muted-text)]">{joining ? `Keep this page open. You will enter ${spaceName} when access is granted.` : `Check your name and devices before you enter ${spaceName}.`}</p>
          {!joining ? (
            <>
              <label className="mt-7 text-sm font-medium" htmlFor="chalk-display-name">
                Your name
              </label>
              <input
                id="chalk-display-name"
                autoComplete="name"
                value={displayName}
                onChange={(event) => onDisplayNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSubmit();
                }}
                className="mt-2 h-11 rounded-md border border-[var(--chalk-line)] bg-[var(--chalk-canvas)] px-3 text-sm outline-none focus-visible:border-[var(--chalk-focus)]"
                placeholder="Enter your name"
              />
            </>
          ) : null}
          <EntranceDeviceControls
            microphone={microphone}
            camera={camera}
            onMicrophoneChange={onMicrophoneChange}
            onCameraChange={onCameraChange}
            audioInputDevices={audioInputDevices}
            videoInputDevices={videoInputDevices}
            audioOutputDevices={audioOutputDevices}
            selectedAudioInput={selectedAudioInput}
            selectedVideoInput={selectedVideoInput}
            selectedAudioOutput={selectedAudioOutput}
            onAudioInputChange={onAudioInputChange}
            onVideoInputChange={onVideoInputChange}
            onAudioOutputChange={onAudioOutputChange}
            disabled={joining}
          />
          {error || previewError ? (
            <p role="alert" className="mt-4 rounded-md border border-[var(--chalk-danger)] bg-[var(--chalk-danger-surface)] px-3 py-2 text-sm text-[var(--chalk-danger)]">
              {error ?? previewError}
            </p>
          ) : null}
          {joining ? (
            <p className="mt-6 text-sm font-medium text-[var(--chalk-muted-text)]" role="status">
              Access request in progress…
            </p>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!displayName.trim()}
              className="mt-6 h-12 rounded-md bg-[var(--chalk-entrance-primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--chalk-entrance-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Enter Space
            </button>
          )}
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="mt-3 h-11 rounded-md border border-[var(--chalk-line)] bg-[var(--chalk-surface)] px-4 text-sm font-semibold text-[var(--chalk-text)] outline-none transition hover:bg-[var(--chalk-canvas)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]"
            >
              {joining ? "Cancel" : "Back"}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
