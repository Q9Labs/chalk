// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { capturedClient, mediaTrack } from "../../../../client/tests/helpers/media-convergence";
import { createCoreTestPlatform } from "../../../../client/src/space-client/core.test.helpers";
import { control } from "../../../../client/src/space-client/terminal.test.helpers";
import { SpaceView } from "./SpaceView";

const cases = (["microphone", "camera"] as const).flatMap((source) => (["live", "recovering"] as const).flatMap((phase) => (["ctrl", "meta", "button"] as const).map((input) => ({ source, phase, input }))));

it.each(cases)("$input cancels live pending $source while Sync is $phase instead of enabling again", async ({ source, phase, input }) => {
  const platform = createCoreTestPlatform();
  const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video" });
  const command = vi.fn(async () => ({ operationId: "target", name: "set_microphone_enabled" as const, serverOutcome: "satisfied" as const, mediaPlaneOutcome: "satisfied" as const }));
  const client = capturedClient(platform, track, { sync: { setMicrophoneEnabled: command, setCameraEnabled: command } });
  await client.join({ microphone: source === "microphone", camera: source === "camera" });
  platform.emitSync({ ...platform.sync.getSnapshot(), control, media: { projectionId: "media", sequence: 1, items: [] } });
  platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ source, track, enabled: true, publicationId: "live-publication" }] });
  expect(track.enabled).toBe(true);
  expect(client.getSnapshot().media.local[source].state).toBe("requesting");
  if (phase === "recovering") {
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase } });
    await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("reconnecting"));
  }
  const action = vi.spyOn(client.media, source === "microphone" ? "setMicrophoneEnabled" : "setCameraEnabled");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    await act(async () => {
      if (input === "button") {
        const button = container.querySelector<HTMLButtonElement>(`button[aria-label="Cancel connecting ${source}"]`);
        expect(button).not.toBeNull();
        expect(button?.disabled).toBe(false);
        button?.click();
      } else document.body.dispatchEvent(new KeyboardEvent("keydown", { key: source === "microphone" ? "d" : "e", ctrlKey: input === "ctrl", metaKey: input === "meta", bubbles: true, cancelable: true }));
    });
    expect(action).toHaveBeenCalledExactlyOnceWith(false);
    expect(track.enabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});
