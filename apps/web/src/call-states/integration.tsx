import { useState } from "react";
import { Chalk } from "@q9labsai/chalk-react";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { createCallStateClient, liveSnapshot } from "./fixtures";
import type { CallState } from "./states";

function IntegratedCall() {
  const [client] = useState(() => {
    const preview = createCallStateClient(liveSnapshot({ self: { camera: false, microphone: false }, others: [{ id: "guest", name: "Guest" }] }));
    const blocked = () => Promise.reject(new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Permission denied" }));
    return { ...preview, media: { ...preview.media, setMicrophoneEnabled: blocked, setCameraEnabled: blocked } };
  });
  return (
    <main className="h-dvh">
      <Chalk client={client} spaceName="Test call" inviteLink="https://example.com/invite/test-call" />
    </main>
  );
}

export const INTEGRATION_STATES: readonly CallState[] = [{ id: "integration-call", title: "Integrated call controls", render: () => <IntegratedCall /> }];
