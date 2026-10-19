import { useState } from "react";
import { Chalk } from "@q9labsai/chalk-react";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { createCallStateClient, liveSnapshot } from "./fixtures";
import type { CallState } from "./states";

function IntegratedCall({ terminal = false }: { readonly terminal?: boolean }) {
  const [report, setReport] = useState("");
  const [client] = useState(() => {
    const preview = createCallStateClient(liveSnapshot({ self: { camera: false, microphone: false }, others: [{ id: "guest", name: "Guest" }] }));
    const blocked = () => Promise.reject(new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Permission denied" }));
    return { ...preview, media: { ...preview.media, setMicrophoneEnabled: blocked, setCameraEnabled: blocked } };
  });
  return (
    <main className="h-dvh">
      <Chalk client={client} spaceName="Test call" inviteLink="https://example.com/invite/test-call" terminalState={terminal ? "removed" : undefined} onReportProblem={({ description }) => setReport(description)} />
      <output aria-label="Submitted problem" className="sr-only">
        {report}
      </output>
    </main>
  );
}

export const INTEGRATION_STATES: readonly CallState[] = [
  { id: "integration-call", title: "Integrated call controls", render: () => <IntegratedCall /> },
  { id: "integration-terminal", title: "Integrated terminal reporting", render: () => <IntegratedCall terminal /> },
];
