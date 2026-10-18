import { useState } from "react";
import { Chalk } from "@q9labsai/chalk-react";
import { createCallStateClient, HOST, PEOPLE, liveSnapshot } from "./fixtures";
import type { CallState } from "./states";

function ShellCall({ host = false, report = false, blocked = false }: { readonly host?: boolean; readonly report?: boolean; readonly blocked?: boolean }) {
  const [command, setCommand] = useState("");
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
    const share = instance.media.setScreenShareEnabled;
    instance.media.setScreenShareEnabled = async (enabled, options) => {
      setCommand(JSON.stringify({ enabled, ...options }));
      await share(enabled, options);
    };
    instance.endEpisode = async () => {
      setCommand("Ended call");
    };
    return instance;
  });
  return (
    <>
      <Chalk
        client={client}
        entrance={false}
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
    </>
  );
}
export const SHELL_STATES: readonly CallState[] = [
  { id: "shell-call", title: "Shell guest", render: () => <ShellCall /> },
  { id: "shell-host", title: "Shell host", render: () => <ShellCall host /> },
  { id: "shell-report", title: "Shell report callback", render: () => <ShellCall report /> },
  { id: "shell-blocked", title: "Shell devices unavailable", render: () => <ShellCall blocked /> },
];
