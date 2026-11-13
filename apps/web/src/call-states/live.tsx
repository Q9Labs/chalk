import { Chalk, type SpaceLayout } from "@q9labsai/chalk-react";
import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";
import { readThemePreference, persistThemePreference } from "../lib/theme";
import { SELF_NAME, SPACE_NAME, createCallStateClient, type BoardFixture, type CallStateClient } from "./fixtures";

export function Live({
  snapshot,
  layout,
  transition: onReady,
  initialColorScheme,
  board,
  width,
  height,
  spaceName = SPACE_NAME,
}: {
  readonly initialColorScheme?: "light" | "dark";
  readonly snapshot: SpaceSnapshot;
  readonly layout?: SpaceLayout;
  readonly transition?: (client: CallStateClient) => void;
  readonly board?: BoardFixture;
  readonly width?: number;
  readonly height?: number;
  readonly spaceName?: string;
}) {
  const [client] = useState(() => createCallStateClient(snapshot, board));
  const [colorScheme, setColorScheme] = useState(() => initialColorScheme ?? readThemePreference(document.cookie));
  const [transition] = useState(() => onReady);
  useEffect(() => {
    if (!transition) return;
    const timer = setTimeout(() => transition(client), 200);
    return () => clearTimeout(timer);
  }, [client, transition]);
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
