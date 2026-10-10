// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { opaqueAccessGrant } from "../../../../client/src/space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../../../../client/src/space-client/space-client";
import { control, terminalTestPlatform } from "../../../../client/src/space-client/terminal.test.helpers";
import { Chalk } from "./Chalk";

vi.mock("../space-view/SpaceView", () => ({ SpaceView: () => <div>Live Space</div> }));
vi.mock("../entrance/Entrance", () => ({ Entrance: () => <div>Entrance</div> }));
vi.mock("../composite/SettingsDialog", () => ({ SettingsDialog: () => null }));
vi.mock("../feedback/FeedbackDialog", () => ({ FeedbackDialog: () => null }));
vi.mock("../media-request-dialog/MediaRequestDialog", () => ({ MediaRequestDialog: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Chalk terminal callbacks with a real SpaceClient", () => {
  it("renders an already-ended join failure and preserves episode.ended for the integrator", async () => {
    const platform = terminalTestPlatform();
    const client = createSpaceClientForPlatform(
      { space: "test", getAccess: async () => opaqueAccessGrant(1) },
      {
        ...platform,
        fetch: async () => new Response(null, { status: 204 }),
        dependencies: {
          ...platform.dependencies,
          createSyncClient: () => ({
            ...platform.sync,
            stop: platform.syncStopped,
            start: async () => {
              platform.emitSync({ ...platform.sync.getSnapshot(), participantId: "participant-1", participantGeneration: 1, connection: { phase: "terminal", terminalReason: "episode_ended" } });
            },
          }),
        },
      },
    );
    const onError = vi.fn();
    const onEpisodeEnded = vi.fn();
    const onJoined = vi.fn();
    const onLeft = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Chalk client={client} entrance={false} defaults={{ microphone: false, camera: false }} onError={onError} onEpisodeEnded={onEpisodeEnded} onJoined={onJoined} onLeft={onLeft} />));
      await act(async () => {
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("failed"));
      });
      expect(client.getSnapshot().connection.lastError?.code).toBe("episode.ended");
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith({ error: expect.objectContaining({ code: "episode.ended" }) });
      expect(onEpisodeEnded).not.toHaveBeenCalled();
      expect(onJoined).not.toHaveBeenCalled();
      expect(onLeft).not.toHaveBeenCalled();
      expect(container.textContent).toContain("The Episode has ended");
      expect(container.textContent).not.toContain("Entering");
    } finally {
      await act(async () => root.unmount());
      client.dispose();
      container.remove();
    }
  });

  it.each(["server end", "participant end", "leave", "removed", "expired Access"] as const)("%s invokes only the appropriate callbacks", async (ending) => {
    const platform = terminalTestPlatform();
    let now = Date.now();
    platform.dependencies.clock.now = () => now;
    let foreground = () => undefined;
    const getAccess = vi.fn(async () => {
      if (getAccess.mock.calls.length > 1) throw new Error("Access unavailable");
      return opaqueAccessGrant(1);
    });
    const client = createSpaceClientForPlatform(
      { space: "test", getAccess },
      {
        ...platform,
        fetch: async () => new Response(null, { status: 204 }),
        dependencies: {
          ...platform.dependencies,
          subscribeForeground: (listener) => {
            foreground = listener;
            return () => undefined;
          },
        },
      },
    );
    const onError = vi.fn();
    const onEpisodeEnded = vi.fn();
    const onJoined = vi.fn();
    const onLeft = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Chalk client={client} onError={onError} onEpisodeEnded={onEpisodeEnded} onJoined={onJoined} onLeft={onLeft} />));
      await act(async () => {
        await client.join({ microphone: false, camera: false });
        platform.emitSync({ ...platform.sync.getSnapshot(), control });
      });
      expect(onJoined).toHaveBeenCalledOnce();
      await act(async () => {
        if (ending === "leave") await client.leave();
        else if (ending === "participant end") await client.endEpisode();
        else if (ending === "expired Access") {
          now += 301_000;
          foreground();
          await vi.waitFor(() => expect(getAccess).toHaveBeenCalledTimes(2));
        } else if (ending === "removed") platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "participant_inactive" } });
        else platform.emitSync({ ...platform.sync.getSnapshot(), control: { ...control, status: ending === "server end" ? "ended" : "active", participants: [] } });
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe(ending === "expired Access" ? "live" : "left"));
      });
      expect(onEpisodeEnded).toHaveBeenCalledTimes(ending === "server end" || ending === "participant end" ? 1 : 0);
      expect(onError).not.toHaveBeenCalled();
      expect(onLeft).toHaveBeenCalledTimes(ending === "expired Access" ? 0 : 1);
      if (ending === "server end" || ending === "participant end") {
        expect(container.textContent).toContain("Episode ended");
        expect(container.textContent).not.toContain("Unable to enter");
      }
    } finally {
      await act(async () => {
        await client.leave().catch(() => undefined);
        root.unmount();
      });
      client.dispose();
      container.remove();
    }
  });
});
