"use client";

import { useEffect, useRef } from "react";
import type React from "react";

import { chalkThemeStyle, type ChalkTheme } from "../../theme";
import { getThemeMode } from "../theme";
import { ChalkAlert, ChalkBadge, ChalkButton, ChalkInput, ChalkPanel } from "../chalk-ui";
import { SkinProvider } from "../skin-context";
import { ClassicEntranceSurface } from "./ClassicEntranceSurface";

/**
 * Internal presentational surface shared by production Entrance and the
 * permission-free SDK preview fixture. It deliberately owns no media access.
 */
export type EntranceSurfaceProps = {
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

function ChalkEntranceSurface({ spaceName, logoUrl, displayName, microphone, camera, joining, error, theme, previewError, previewStream = null, onDisplayNameChange, onMicrophoneChange, onCameraChange, onSubmit, onCancel }: EntranceSurfaceProps): React.JSX.Element {
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
        className="chalk-root chalk-textured-surface relative grid h-full min-h-0 w-full place-items-center overflow-hidden bg-[var(--chalk-canvas)] p-4 text-[var(--chalk-text)]"
      >
        <section className="w-full max-w-5xl">
          <ChalkPanel className="w-full bg-[var(--chalk-surface)] p-0" contentClassName="grid w-full lg:grid-cols-[minmax(0,1fr)_24rem]" data-chalk-entrance-layout="split" tone="neutral">
            <div className="border-b border-[var(--chalk-app-line,var(--chalk-line))] p-5 lg:border-r lg:border-b-0">
              <header className="mb-5 flex items-center gap-3">
                {logoUrl ? <img src={logoUrl} alt="Chalk" className="h-auto w-28" draggable={false} /> : <span className="text-xl font-bold">Chalk</span>}
                <span className="truncate text-sm text-[var(--chalk-muted-text)]">{spaceName}</span>
              </header>
              <ChalkPanel className="relative aspect-video overflow-hidden bg-[var(--chalk-stage)] p-0" contentClassName="h-full" filled={false}>
                <video ref={videoRef} autoPlay playsInline muted className={hasVideoPreview ? "h-full w-full -scale-x-100 object-cover" : "hidden"} />
                {!hasVideoPreview ? <div className="grid h-full place-items-center text-sm text-[var(--chalk-muted-text)]">Camera preview</div> : null}
                <ChalkBadge tone="neutral" className="absolute bottom-3 left-3 bg-[var(--chalk-app-text,var(--chalk-text))] px-2 py-1 text-xs text-[var(--chalk-app-canvas,var(--chalk-accent-text))]">
                  {displayName.trim() || "You"}
                </ChalkBadge>
              </ChalkPanel>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Toggle label="Microphone" enabled={microphone} disabled={joining} onChange={onMicrophoneChange} />
                <Toggle label="Camera" enabled={camera} disabled={joining} onChange={onCameraChange} />
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
                <ChalkButton type="button" onClick={onSubmit} disabled={!displayName.trim()} variant="solid" tone="accent" className="mt-6 h-12 w-full text-sm font-semibold text-[var(--chalk-accent-text)]">
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

function Toggle({ label, enabled, disabled = false, onChange }: { readonly label: string; readonly enabled: boolean; readonly disabled?: boolean; readonly onChange: (enabled: boolean) => void }): React.JSX.Element {
  return (
    <ChalkButton type="button" aria-pressed={enabled} disabled={disabled} onClick={() => onChange(!enabled)} variant={enabled ? "solid" : "outline"} tone={enabled ? "success" : "danger"} className="w-full justify-between px-4 py-3 text-left text-sm">
      <span>{label}</span>
      <span className={enabled ? "text-[var(--chalk-positive)]" : "text-[var(--chalk-danger)]"}>{enabled ? "On" : "Off"}</span>
    </ChalkButton>
  );
}
