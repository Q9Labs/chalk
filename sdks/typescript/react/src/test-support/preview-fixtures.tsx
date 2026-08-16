"use client";

import { useEffect, useState } from "react";
import type React from "react";
import type { SpaceClient } from "@q9labsai/chalk-client";

import { CommandErrorAlert } from "../components/composite/CommandErrorAlert";
import type { SpaceLayout } from "../components/chalk/Chalk";
import { EntranceSurface } from "../components/entrance/EntranceSurface";
import type { EntranceProps, EntranceSettings } from "../components/entrance/Entrance";
import { JoinFailedScreen } from "../components/join-failed-screen/JoinFailedScreen";
import { LeaveDialog } from "../components/leave-dialog/LeaveDialog";
import { SpaceView, type SpacePanel, type SpaceViewProps } from "../components/space-view/SpaceView";
import { ChalkProvider } from "../bindings/context";
import { createPreviewClient } from "./preview-client";
import { getThemeMode, THEME_PALETTES, THEME_TEXTURES, type ThemeAppearance, type ThemeMode, type ThemePalette, type ThemeTexture } from "../components/theme";

/**
 * DEV-only adapter for the URL-addressable SDK gallery. It deliberately lives
 * outside every package entrypoint so preview state cannot become product API.
 */
export type PreviewEntranceProps = Omit<EntranceProps, "defaults"> & {
  readonly microphone?: boolean;
  readonly camera?: boolean;
};

/**
 * Permission-free fixture adapter. It uses the canonical Entrance surface but
 * never mounts production media acquisition effects, so URL-driven gallery
 * states remain deterministic in browsers, tests, and documentation embeds.
 */
export function PreviewEntrance({ microphone = true, camera = true, defaultDisplayName = "", joining = false, error, onJoin, onCancel, spaceName, logoUrl, theme }: PreviewEntranceProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(microphone);
  const [cameraEnabled, setCameraEnabled] = useState(camera);

  useEffect(() => setDisplayName(defaultDisplayName), [defaultDisplayName]);
  useEffect(() => setMicrophoneEnabled(microphone), [microphone]);
  useEffect(() => setCameraEnabled(camera), [camera]);

  const onSubmit = () => {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName || joining) return;
    void onJoin({ displayName: normalizedDisplayName, microphone: microphoneEnabled, camera: cameraEnabled });
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
      onDisplayNameChange={setDisplayName}
      onMicrophoneChange={setMicrophoneEnabled}
      onCameraChange={setCameraEnabled}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/** The gallery supplies all state and commands; the production Chalk wrapper is never involved. */
export type PreviewSpaceViewProps = SpaceViewProps & { readonly client?: SpaceClient };

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

export function PreviewEpisodeEnded({ spaceName, duration, participantCount, onRejoin, onGoHome }: { readonly spaceName: string; readonly duration: number; readonly participantCount: number; readonly onRejoin?: () => void; readonly onGoHome?: () => void }): React.JSX.Element {
  return (
    <main data-chalk className="chalk-root grid min-h-screen place-items-center bg-[var(--chalk-canvas)] p-6 text-center text-[var(--chalk-text)]">
      <section className="grid max-w-md gap-4 justify-items-center rounded-lg border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-8">
        <h1 className="text-2xl font-semibold">Episode ended</h1>
        <p className="text-sm text-[var(--chalk-muted-text)]">
          {spaceName} · {participantCount} Participants · {duration}s
        </p>
        <div className="flex gap-3">
          {onRejoin ? (
            <button type="button" onClick={onRejoin} className="rounded-md bg-[var(--chalk-accent)] px-4 py-2 text-sm font-semibold text-[var(--chalk-accent-text)]">
              Enter again
            </button>
          ) : null}
          {onGoHome ? (
            <button type="button" onClick={onGoHome} className="rounded-md border border-[var(--chalk-line)] px-4 py-2 text-sm font-semibold">
              Back to Entrance
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export { CommandErrorAlert, JoinFailedScreen, LeaveDialog, getThemeMode, THEME_PALETTES, THEME_TEXTURES };
export type { EntranceSettings, SpaceLayout, SpacePanel, SpaceViewProps, ThemeAppearance, ThemeMode, ThemePalette, ThemeTexture };
