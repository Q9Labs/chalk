"use client";

import { useEffect, useRef } from "react";
import type React from "react";

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
  readonly previewError?: string | null;
  readonly previewStream?: MediaStream | null;
  readonly onDisplayNameChange: (displayName: string) => void;
  readonly onMicrophoneChange: (enabled: boolean) => void;
  readonly onCameraChange: (enabled: boolean) => void;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
};

export function EntranceSurface({ spaceName, logoUrl, displayName, microphone, camera, joining, error, previewError, previewStream = null, onDisplayNameChange, onMicrophoneChange, onCameraChange, onSubmit, onCancel }: EntranceSurfaceProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = previewStream;
    return () => {
      if (videoRef.current?.srcObject === previewStream) videoRef.current.srcObject = null;
    };
  }, [previewStream]);

  const hasVideoPreview = camera && Boolean(previewStream?.getVideoTracks().length);

  return (
    <main data-chalk className="chalk-root grid h-full min-h-0 w-full place-items-center bg-[var(--chalk-canvas)] p-4 text-[var(--chalk-text)]">
      <section className="grid w-full max-w-5xl overflow-hidden rounded-lg border border-[var(--chalk-line)] bg-[var(--chalk-surface)] shadow-[var(--chalk-shadow)] lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="border-b border-[var(--chalk-line)] p-5 lg:border-r lg:border-b-0">
          <header className="mb-5 flex items-center gap-3">
            {logoUrl ? <img src={logoUrl} alt="Chalk" className="h-auto w-28" draggable={false} /> : <span className="text-xl font-bold">Chalk</span>}
            <span className="truncate text-sm text-[var(--chalk-muted-text)]">{spaceName}</span>
          </header>
          <div className="relative aspect-video overflow-hidden rounded-md border border-[var(--chalk-line)] bg-[var(--chalk-stage)]">
            <video ref={videoRef} autoPlay playsInline muted className={hasVideoPreview ? "h-full w-full -scale-x-100 object-cover" : "hidden"} />
            {!hasVideoPreview ? <div className="grid h-full place-items-center text-sm text-[var(--chalk-muted-text)]">Camera preview</div> : null}
            <span className="absolute bottom-3 left-3 rounded bg-[var(--chalk-text)] px-2 py-1 text-xs text-[var(--chalk-accent-text)]">{displayName.trim() || "You"}</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Toggle label="Microphone" enabled={microphone} onChange={onMicrophoneChange} />
            <Toggle label="Camera" enabled={camera} onChange={onCameraChange} />
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
            <button type="button" onClick={onSubmit} disabled={!displayName.trim()} className="mt-6 h-12 rounded-md bg-[var(--chalk-accent)] px-4 text-sm font-semibold text-[var(--chalk-accent-text)] disabled:cursor-not-allowed disabled:opacity-50">
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

function Toggle({ label, enabled, onChange }: { readonly label: string; readonly enabled: boolean; readonly onChange: (enabled: boolean) => void }): React.JSX.Element {
  return (
    <button type="button" aria-pressed={enabled} onClick={() => onChange(!enabled)} className="flex items-center justify-between rounded-md border border-[var(--chalk-line)] bg-[var(--chalk-surface)] px-4 py-3 text-left text-sm hover:bg-[var(--chalk-canvas)]">
      <span>{label}</span>
      <span className={enabled ? "text-[var(--chalk-positive)]" : "text-[var(--chalk-danger)]"}>{enabled ? "On" : "Off"}</span>
    </button>
  );
}
