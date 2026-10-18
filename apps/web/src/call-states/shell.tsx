import { SpaceClientError, type ClientFailure, type MediaSource, type ScreenShareOptions } from "@q9labsai/chalk-client";
import { readThemePreference, persistThemePreference, type ThemePreference } from "../lib/theme";
import { useState } from "react";
import { Chalk, ChalkProvider, ControlBar, SpaceHeader } from "@q9labsai/chalk-react";
import { createCallStateClient, HOST, PEOPLE, liveSnapshot } from "./fixtures";
import type { CallState } from "./states";

function ShellCall({ host = false, report = false, blocked = false, paged = false, initialColorScheme }: { readonly host?: boolean; readonly report?: boolean; readonly blocked?: boolean; readonly paged?: boolean; readonly initialColorScheme?: ThemePreference }) {
  const [command, setCommand] = useState("");
  const [colorScheme, setColorScheme] = useState(() => initialColorScheme ?? readThemePreference(document.cookie));
  const [client] = useState(() => {
    const snapshot = liveSnapshot({ others: paged ? PEOPLE : PEOPLE.slice(0, 7), capabilities: host ? HOST : undefined });
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
function ShellSeams() {
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<(ClientFailure & { source?: MediaSource }) | null>(null);
  const [client] = useState(() => {
    const instance = createCallStateClient(liveSnapshot());
    return {
      ...instance,
      media: {
        ...instance.media,
        setMicrophoneEnabled: async () => {
          throw new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Microphone access was blocked" });
        },
        setCameraEnabled: async () => {
          throw new SpaceClientError({ code: "media.device_not_found", recoverable: true, message: "Camera was not found" });
        },
        setScreenShareEnabled: async () => {
          throw new Error("Screen capture failed");
        },
      },
    };
  });
  const toggle = () => setOpen((current) => !current);
  return (
    <main data-chalk data-chalk-theme="dark" data-part="call-frame" className="chalk-root chalk-frame" style={{ height: "100dvh" }}>
      <ChalkProvider client={client}>
        <SpaceHeader spaceName="Shell seams" callLinkOpen={open} onCallLinkToggle={toggle} />
        <div className="chalk-frame-dock">
          <ControlBar buttons={["mic", "video", "screenshare"]} callLinkOpen={open} onCallLinkToggle={toggle} onCommandError={(error, source) => setFailure(error ? { code: error.code, message: error.message, recoverable: error.recoverable, source } : null)} />
        </div>
      </ChalkProvider>
      <output aria-label="Shell failure" className="sr-only">
        {JSON.stringify(failure)}
      </output>
    </main>
  );
}
export const SHELL_STATES: readonly CallState[] = [
  { id: "shell-seams", title: "Shell merge seams", render: () => <ShellSeams /> },
  { id: "shell-call", title: "Shell guest", render: () => <ShellCall /> },
  { id: "shell-light", title: "Shell guest in Light", render: () => <ShellCall initialColorScheme="light" /> },
  { id: "shell-host", title: "Shell host", render: () => <ShellCall host /> },
  { id: "shell-report", title: "Shell report callback", render: () => <ShellCall report /> },
  { id: "shell-report-light", title: "Shell report callback, Light", render: () => <ShellCall report initialColorScheme="light" /> },
  { id: "shell-blocked", title: "Shell devices unavailable", render: () => <ShellCall blocked /> },
  { id: "shell-paged", title: "Shell phone pagination", render: () => <ShellCall paged /> },
];
