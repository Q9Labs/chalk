import type { ScreenShareOptions } from "@q9labsai/chalk-client";
import { readThemePreference, persistThemePreference } from "../lib/theme";
import { useState } from "react";
import { Chalk } from "@q9labsai/chalk-react";
import { createCallStateClient, HOST, PEOPLE, liveSnapshot } from "./fixtures";
import type { CallState } from "./states";

function ShellCall({ host = false, report = false, blocked = false }: { readonly host?: boolean; readonly report?: boolean; readonly blocked?: boolean }) {
  const [command, setCommand] = useState("");
  const [colorScheme, setColorScheme] = useState(() => readThemePreference(document.cookie));
  const [client] = useState(() => {
    const snapshot = liveSnapshot({ others: PEOPLE.slice(0, 7), capabilities: host ? HOST : undefined });
    const instance = createCallStateClient({
      ...snapshot,
      media: {
        ...snapshot.media,
        devices: {
          microphones: [
            { deviceId: "mic-1", label: "Built-in Microphone" },
            { deviceId: "mic-2", label: "Headset Microphone" },
          ],
          cameras: [
            { deviceId: "cam-1", label: "Built-in Camera" },
            { deviceId: "cam-2", label: "External Camera" },
          ],
          speakers: [{ deviceId: "speaker-1", label: "Built-in Speakers" }],
        },
        selection: { microphone: "mic-1", camera: "cam-1", speaker: "speaker-1" },
        local: blocked ? { ...snapshot.media.local, microphone: { ...snapshot.media.local.microphone, state: "failed" }, camera: { ...snapshot.media.local.camera, state: "unavailable" } } : snapshot.media.local,
      },
    });
    return {
      ...instance,
      media: {
        ...instance.media,
        setScreenShareEnabled: async (enabled: boolean, options?: ScreenShareOptions) => {
          setCommand(JSON.stringify({ enabled, ...options }));
          await instance.media.setScreenShareEnabled(enabled, options);
        },
      },
      endEpisode: async () => {
        setCommand("Ended call");
        await instance.endEpisode();
      },
    };
  });
  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      <Chalk
        theme={{ colorScheme }}
        onColorSchemeChange={(next) => {
          setColorScheme(next);
          persistThemePreference(next);
        }}
        client={client}
        spaceName="Team call"
        shareUrl="https://chalkmeet.com/team-call"
        onReportProblem={
          report
            ? async ({ description }) => {
                setCommand(`Reported: ${description}`);
              }
            : undefined
        }
        onLeft={() => {
          setCommand("Left call");
        }}
      />
      <output className="sr-only" aria-label="Last shell command">
        {command}
      </output>
    </main>
  );
}
export const SHELL_STATES: readonly CallState[] = [
  { id: "shell-call", title: "Shell guest", render: () => <ShellCall /> },
  { id: "shell-host", title: "Shell host", render: () => <ShellCall host /> },
  { id: "shell-report", title: "Shell report callback", render: () => <ShellCall report /> },
  { id: "shell-blocked", title: "Shell devices unavailable", render: () => <ShellCall blocked /> },
];
