"use client";

import { useEffect, useRef } from "react";
import type React from "react";

import { chalkThemeStyle, type ChalkTheme } from "../../theme";
import { getThemeMode } from "../theme";
import { ChalkAlert, ChalkBadge, ChalkButton, ChalkInput, ChalkPanel } from "../chalk-ui";
import { LogoSource } from "../logo/LogoSource";
import { SkinProvider } from "../skin-context";
import { ClassicEntranceSurface } from "./ClassicEntranceSurface";
import { EntranceDeviceControls } from "./EntranceDeviceControls";
import { EntranceParticipantPreview } from "./EntranceParticipantPreview";
import type { EntranceDeviceOptions } from "./types";

/**
 * Internal presentational surface shared by production Entrance and the
 * permission-free SDK preview fixture. It deliberately owns no media access.
 */
export type EntranceSurfaceProps = EntranceDeviceOptions & {
  readonly spaceName: string;
  readonly logoUrl?: string;
  readonly displayName: string;
  readonly microphone: boolean;
  readonly camera: boolean;
  readonly joining: boolean;
  readonly error?: string;
  readonly theme?: ChalkTheme;
  readonly previewError?: string | null;
  readonly previewStream?: MediaStream | null;
  readonly generatedAvatars?: boolean;
  readonly onDisplayNameChange: (displayName: string) => void;
  readonly onMicrophoneChange: (enabled: boolean) => void;
  readonly onCameraChange: (enabled: boolean) => void;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
};

export function EntranceSurface(props: EntranceSurfaceProps): React.JSX.Element {
  const skin = props.theme?.skin ?? "classic";

  return <SkinProvider skin={skin}>{skin === "classic" ? <ClassicEntranceSurface {...props} /> : <ChalkEntranceSurface {...props} />}</SkinProvider>;
}

function ChalkEntranceSurface({
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
  const skin = theme?.skin ?? "classic";

  return (
    <SkinProvider skin={skin}>
      <main
        data-chalk
        data-chalk-theme={colorScheme}
        data-chalk-palette={theme?.palette}
        data-chalk-texture={theme?.texture}
        data-chalk-skin={skin}
        aria-busy={joining}
        style={chalkThemeStyle(theme, colorScheme)}
        className="chalk-root chalk-textured-surface relative grid h-full min-h-0 w-full place-items-center overflow-auto bg-[var(--chalk-canvas)] p-4 text-[var(--chalk-text)]"
      >
        <section className="w-full max-w-5xl max-h-full overflow-hidden overflow-y-auto">
          <ChalkPanel className="w-full bg-[var(--chalk-surface)] p-0" contentClassName="grid w-full lg:grid-cols-[minmax(0,1fr)_24rem]" data-chalk-entrance-layout="split" tone="neutral">
            <div className="border-b border-[var(--chalk-app-line,var(--chalk-line))] p-5 lg:border-r lg:border-b-0 lg:p-6">
              <header className="mb-5 flex items-center gap-3">
                <LogoSource className="h-auto w-28" height={32} logoUrl={logoUrl} />
                <span className="truncate text-sm text-[var(--chalk-muted-text)]">{spaceName}</span>
              </header>
              <ChalkPanel className="relative aspect-video min-h-[15rem] overflow-hidden bg-[var(--chalk-stage)] p-0 lg:aspect-[4/3]" contentClassName="h-full" filled={false}>
                <video ref={videoRef} autoPlay playsInline muted className={hasVideoPreview ? "h-full w-full -scale-x-100 object-cover" : "hidden"} />
                {!hasVideoPreview ? <EntranceParticipantPreview displayName={displayName} microphone={microphone} generatedAvatars={generatedAvatars} /> : null}
                {hasVideoPreview ? (
                  <ChalkBadge tone="neutral" className="absolute bottom-3 left-3 bg-[var(--chalk-app-text,var(--chalk-text))] px-2 py-1 text-xs text-[var(--chalk-app-canvas,var(--chalk-accent-text))]">
                    {displayName.trim() || "You"}
                  </ChalkBadge>
                ) : null}
              </ChalkPanel>
            </div>
            <div className="flex flex-col justify-center p-6">
              <h1 className="text-3xl font-semibold">{joining ? "Requesting access" : "Enter this Space"}</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--chalk-muted-text)]">{joining ? `Keep this page open. You will enter ${spaceName} when access is granted.` : `Check your name and devices before you enter ${spaceName}.`}</p>
              {!joining ? (
                <>
                  <label className="mt-7 text-sm font-medium" htmlFor="chalk-display-name">
                    Your name
                  </label>
                  <ChalkInput
                    id="chalk-display-name"
                    autoComplete="name"
                    value={displayName}
                    onChange={(event) => onDisplayNameChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onSubmit();
                    }}
                    wrapperClassName="mt-2"
                    className="h-11 bg-[var(--chalk-canvas)] text-sm"
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
                <ChalkAlert tone="danger" className="mt-4 px-3 py-2 text-sm text-[var(--chalk-danger)]">
                  {error ?? previewError}
                </ChalkAlert>
              ) : null}
              {joining ? (
                <p className="mt-6 text-sm font-medium text-[var(--chalk-muted-text)]" role="status">
                  Access request in progress…
                </p>
              ) : (
                <ChalkButton type="button" onClick={onSubmit} disabled={!displayName.trim()} variant="solid" tone="accent" className="mt-6 h-12 w-full [--chalk-accent:var(--chalk-entrance-primary)] text-sm font-semibold !text-white hover:[--chalk-accent:var(--chalk-entrance-primary-hover)]">
                  Enter Space
                </ChalkButton>
              )}
              {onCancel ? (
                <ChalkButton type="button" onClick={onCancel} variant="outline" tone="neutral" className="mt-3 h-11 w-full text-sm font-semibold text-[var(--chalk-text)]">
                  {joining ? "Cancel" : "Back"}
                </ChalkButton>
              ) : null}
            </div>
          </ChalkPanel>
        </section>
      </main>
    </SkinProvider>
  );
}
