import { Chalk, type SpaceLayout } from "@q9labsai/chalk-react";
import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";
import { readThemePreference, persistThemePreference } from "../lib/theme";
import { SELF_NAME, SPACE_NAME, createCallStateClient, type BoardFixture, type CallStateClient } from "./fixtures";

export function Live({
  snapshot,
  layout,
  step: onReady,
  initialColorScheme,
  board,
  width,
  height,
  spaceName = SPACE_NAME,
}: {
  readonly initialColorScheme?: "light" | "dark";
  readonly snapshot: SpaceSnapshot;
  readonly layout?: SpaceLayout;
  readonly step?: (client: CallStateClient) => void;
  readonly board?: BoardFixture;
  readonly width?: number;
  readonly height?: number;
  readonly spaceName?: string;
}) {
  const [client] = useState(() => createCallStateClient(snapshot, board));
  const [colorScheme, setColorScheme] = useState(() => initialColorScheme ?? readThemePreference(document.cookie));
  const [step] = useState(() => onReady);
  useEffect(() => {
    if (!step) return;
    const timer = setTimeout(() => step(client), 200);
    return () => clearTimeout(timer);
  }, [client, step]);
  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden" style={width || height ? { width, height } : undefined}>
      <Chalk
        theme={{ colorScheme }}
        onColorSchemeChange={(next) => {
          setColorScheme(next);
          persistThemePreference(next);
        }}
        client={client}
        displayName={SELF_NAME}
        spaceName={spaceName}
        layout={layout}
        onLeft={() => undefined}
        onHome={() => undefined}
      />
    </main>
  );
}

/** Recording that has just started: the call opens with the start still pending, then the recording confirms. */
export function RecordingStarts({ snapshot }: { readonly snapshot: SpaceSnapshot }) {
  const starting = { ...snapshot, recording: { ...snapshot.recording, current: { recordingId: "rec-1", status: "starting" as const, failureCode: null } } };
  return <Live snapshot={starting} step={(client) => client.updateSnapshot(() => snapshot)} />;
}
