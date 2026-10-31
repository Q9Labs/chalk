import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createSpaceClientForPlatform } from "matrix-client-effect";
import { ChalkProvider } from "matrix-react-context";
import { useMedia, useSpaceClient } from "matrix-react-hooks";
import { useConnectedControlBarBehavior } from "matrix-react-controls";
import { AudioOutput } from "matrix-react-audio-output";

function Controls() {
  const client = useSpaceClient();
  const media = useMedia();
  const controls = useConnectedControlBarBehavior({});
  window.matrixCommandError = controls.commandError;
  window.matrixClient = client;
  return (
    <>
      <AudioOutput />
      <button id="mic" onClick={controls.surfaceProps.onToggleMute}>
        Microphone
      </button>
      <button id="camera" onClick={controls.surfaceProps.onToggleVideo}>
        Camera
      </button>
      <button
        id="moderator"
        onClick={() => {
          void client.participants.mute(window.matrixMuteTarget).catch((error) => window.matrixErrors.push({ kind: "moderator", message: error.message }));
        }}
      >
        Mute student
      </button>
      <output>{media.local.microphone.state}</output>
    </>
  );
}

window.matrixJoin = async (config) => {
  const client = createSpaceClientForPlatform(
    {
      space: config.space,
      baseUrl: config.baseUrl,
      getAccess: (request) => window.matrixAccess(request),
    },
    { syncUrl: config.syncUrl },
  );
  createRoot(document.querySelector("#root")).render(
    <ChalkProvider client={client}>
      <Controls />
    </ChalkProvider>,
  );
  window.matrixClient = client;
  await client.join({ displayName: config.name, microphone: config.microphone === true, camera: false });
};
