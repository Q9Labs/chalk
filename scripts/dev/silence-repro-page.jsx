import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createSpaceClientForPlatform } from "matrix-client-effect";
import { ChalkProvider } from "matrix-react-context";
import { useMedia, useSpaceClient } from "matrix-react-hooks";
import { useConnectedControlBarBehavior } from "matrix-react-controls";

function Controls() {
  const client = useSpaceClient();
  const media = useMedia();
  const controls = useConnectedControlBarBehavior({});
  window.matrixCommandError = controls.commandError;
  useEffect(() => {
    const elements = media.remote
      .filter((remote) => remote.source === "microphone")
      .map((remote) => {
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.srcObject = new MediaStream([remote.track]);
        document.body.append(audio);
        const entry = { audio, play: "pending" };
        (window.srElements ??= {})[remote.track.id] = entry;
        audio.play().then(
          () => (entry.play = "ok"),
          (error) => {
            entry.play = `error:${error.name}`;
            window.matrixErrors.push({ kind: "playback", message: error.message });
          },
        );
        return audio;
      });
    return () =>
      elements.forEach((audio) => {
        audio.srcObject = null;
        audio.remove();
      });
  }, [media.remote]);
  window.matrixClient = client;
  // Click trace for the harness: what the UI offered, whether the handler fired, and what the SDK call did.
  window.srUi = { state: media.local.microphone.state, canToggle: controls.surfaceProps.onToggleMute !== undefined };
  const trace = (window.srTrace ??= []);
  if (!client.media.srWrapped) {
    try {
      const original = client.media.setMicrophoneEnabled.bind(client.media);
      client.media.setMicrophoneEnabled = async (...args) => {
        const entry = { kind: "setMicrophoneEnabled", args, at: Date.now() };
        trace.push(entry);
        try {
          const result = await original(...args);
          entry.ok = true;
          return result;
        } catch (error) {
          entry.error = error?.message ?? String(error);
          throw error;
        } finally {
          entry.endAt = Date.now();
        }
      };
      client.media.srWrapped = true;
    } catch (error) {
      trace.push({ kind: "wrap-failed", message: error.message, at: Date.now() });
    }
  }
  return (
    <>
      <button
        id="mic"
        onClick={() => {
          trace.push({ kind: "click", at: Date.now(), state: media.local.microphone.state, handler: controls.surfaceProps.onToggleMute !== undefined });
          controls.surfaceProps.onToggleMute?.();
        }}
      >
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
