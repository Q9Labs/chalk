// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opaqueAccessGrant } from "../../../../client/src/space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../../../../client/src/space-client/space-client";
import { control, terminalTestPlatform } from "../../../../client/src/space-client/terminal.test.helpers";
import { V1CommandScheduler } from "../../../../client/src/sync/v1-command-scheduler";
import { InMemoryV1PendingTargetStore } from "../../../../client/src/sync/v1-persistence";
import { Chalk } from "./Chalk";
import { CloudflareSFUError } from "../../../../client/src/media";
import { track } from "../../../../client/src/space-client/capture.test.helpers";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

vi.mock("../space-view/SpaceView", () => ({ SpaceView: () => <div>Live Space</div> }));
vi.mock("../media-request-dialog/MediaRequestDialog", () => ({ MediaRequestDialog: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Chalk terminal callbacks with a real SpaceClient", () => {
  it.each(["confirmed", "unconfirmed"] as const)("notifies local departure before %s cleanup and keeps its acknowledgement alive after unmount", async (outcome) => {
    const platform = terminalTestPlatform();
    const departure = Promise.withResolvers<void>();
    platform.leave.mockImplementation(async () => {
      await departure.promise;
      return { type: "ack", command_id: "leave", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" };
    });
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, { ...platform, dependencies: { ...platform.dependencies, cancelPendingAdmission: async () => false } });
    const microphone = track("audio");
    const camera = track("video");
    platform.stopped.mockImplementation(() => {
      microphone.stop();
      camera.stop();
    });
    const onLeft = vi.fn(() => {
      expect(microphone.readyState).toBe("ended");
      expect(camera.readyState).toBe("ended");
      expect(platform.stopped).not.toHaveBeenCalled();
    });
    const error = vi.fn();
    client.on("error", error);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let mounted = true;
    let leaving: Promise<boolean> | undefined;
    try {
      await act(async () => root.render(<Chalk client={client} defaults={{ microphone: false, camera: false }} onLeft={onLeft} />));
      await act(async () => {
        await client.join({ microphone: false, camera: false });
        platform.emitSync({ ...platform.sync.getSnapshot(), control });
        platform.media.emit({
          ...platform.media.getSnapshot(),
          localTracks: [
            { source: "microphone", enabled: true, publicationId: "microphone", track: microphone },
            { source: "camera", enabled: true, publicationId: "camera", track: camera },
          ],
        });
      });
      let settled = false;
      await act(async () => {
        leaving = client
          .leave()
          .then(
            () => true,
            () => false,
          )
          .finally(() => {
            settled = true;
          });
        await vi.waitFor(() => expect(platform.leave).toHaveBeenCalledOnce());
      });
      expect(onLeft).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("You left");
      expect(settled).toBe(false);
      expect(platform.syncStopped).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      mounted = false;
      const cleanup = client
        .leave()
        .catch(() => undefined)
        .finally(() => client.dispose());
      expect(platform.stopped).not.toHaveBeenCalled();
      expect(platform.syncStopped).not.toHaveBeenCalled();
      if (outcome === "confirmed") departure.resolve();
      else departure.reject(new Error("Durable departure failed"));
      expect(await leaving).toBe(outcome === "confirmed");
      await cleanup;
      expect(platform.stopped).toHaveBeenCalledOnce();
      expect(platform.syncStopped).toHaveBeenCalledOnce();
      expect(onLeft).toHaveBeenCalledOnce();
      if (outcome === "confirmed") expect(error).not.toHaveBeenCalled();
      else expect(error).toHaveBeenCalledWith({ error: expect.objectContaining({ code: "connection.leave_unconfirmed" }) });
    } finally {
      departure.resolve();
      await leaving;
      if (mounted) await act(async () => root.unmount());
      client.dispose();
      container.remove();
    }
  });

  it("displays explicit-rejoin guidance for rejected startup media without refreshing access", async () => {
    const platform = terminalTestPlatform();
    const getAccess = vi.fn(async () => opaqueAccessGrant(1));
    const client = createSpaceClientForPlatform(
      { space: "test", getAccess },
      {
        ...platform,
        dependencies: {
          ...platform.dependencies,
          createMediaClient: (input) => ({
            ...platform.dependencies.createMediaClient(input),
            start: async () => {
              throw new CloudflareSFUError("startup access rejected", "signaling_failed", { status: 403 });
            },
          }),
        },
      },
    );
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Chalk client={client} defaults={{ microphone: false, camera: false }} onError={onError} />));
      await act(async () => {
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("failed"));
      });
      expect(client.getSnapshot().connection.lastError).toMatchObject({ code: "access.invalid", recoverable: false });
      expect(getAccess).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith({ error: expect.objectContaining({ code: "access.invalid", recoverable: false }) });
      expect(container.textContent).toContain("Rejoin explicitly to request access again.");
      expect(container.textContent).toContain("Reference: access.invalid");
      expect(container.textContent).not.toContain("Audio and video could not connect");
    } finally {
      await act(async () => root.unmount());
      client.dispose();
      container.remove();
    }
  });

  it("offers terminal reporting only after leave settles, so cleanup cannot discard an opened form", async () => {
    const platform = terminalTestPlatform();
    const departure = Promise.withResolvers<void>();
    platform.leave.mockImplementation(async () => {
      await departure.promise;
      return { type: "ack", command_id: "leave", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" };
    });
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, { ...platform, fetch: async () => new Response(null, { status: 204 }) });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onLeft = vi.fn();
    let leaving: Promise<void> | undefined;
    try {
      await act(async () => root.render(<Chalk client={client} defaults={{ microphone: false, camera: false }} onLeft={onLeft} onReportProblem={async () => undefined} />));
      await act(async () => {
        await client.join({ microphone: false, camera: false });
        platform.emitSync({ ...platform.sync.getSnapshot(), control });
      });
      await act(async () => {
        leaving = client.leave();
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("leaving"));
      });
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Report a problem")).toBe(false);
      expect(onLeft).toHaveBeenCalledOnce();
      await act(async () => {
        departure.resolve();
        await leaving;
      });
      expect(client.getSnapshot().connection.status).toBe("left");
      expect(onLeft).toHaveBeenCalledOnce();
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Report a problem")).toBe(true);
    } finally {
      departure.resolve();
      await act(async () => {
        await leaving;
        root.unmount();
      });
      client.dispose();
      container.remove();
    }
  });

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
      await act(async () => root.render(<Chalk client={client} defaults={{ microphone: false, camera: false }} onError={onError} onEpisodeEnded={onEpisodeEnded} onJoined={onJoined} onLeft={onLeft} />));
      await act(async () => {
        await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("failed"));
      });
      expect(client.getSnapshot().connection.lastError?.code).toBe("episode.ended");
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith({ error: expect.objectContaining({ code: "episode.ended" }) });
      expect(onEpisodeEnded).not.toHaveBeenCalled();
      expect(onJoined).not.toHaveBeenCalled();
      expect(onLeft).not.toHaveBeenCalled();
      expect(container.textContent).toContain("The call ended");
      expect(container.textContent).not.toContain("Joining");
    } finally {
      await act(async () => root.unmount());
      client.dispose();
      container.remove();
    }
  });

  it("completes Leave without an error when sync rejects the Leave as participant_inactive", async () => {
    const platform = terminalTestPlatform();
    const scheduler: V1CommandScheduler = new V1CommandScheduler({
      store: new InMemoryV1PendingTargetStore(),
      ids: undefined,
      maxPendingCommands: undefined,
      maxPendingBytes: undefined,
      maxPendingAgeMs: undefined,
      maxOperationPendingAgeMs: undefined,
      retryDelayMs: undefined,
      clock: () => platform.dependencies.clock,
      isStarted: () => true,
      sendIfLive: (frame) => {
        if (frame.type === "operation") queueMicrotask(() => void scheduler.acknowledge({ type: "ack", command_id: frame.command_id, delivery: "original", outcome: "rejected", reason: "participant_inactive" }));
      },
      stateChanged: () => undefined,
      ackHeadIsProven: () => true,
      controlHead: () => ({ revision: control.revision, state_digest: control.stateDigest }),
    });
    platform.leave.mockImplementation(() => scheduler.sendOperation((commandId) => ({ type: "operation", command_id: commandId, name: "participant_leave", payload: {} }), 0));
    const client = createSpaceClientForPlatform({ space: "test", getAccess: async () => opaqueAccessGrant(1) }, { ...platform, dependencies: { ...platform.dependencies, cancelPendingAdmission: async () => false } });
    const error = vi.fn();
    client.on("error", error);
    const onError = vi.fn();
    const onLeft = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Chalk client={client} defaults={{ microphone: false, camera: false }} onError={onError} onLeft={onLeft} />));
      await act(async () => {
        await client.join({ microphone: false, camera: false });
        platform.emitSync({ ...platform.sync.getSnapshot(), control });
      });
      await act(async () => {
        await client.leave();
      });
      expect(platform.leave).toHaveBeenCalledOnce();
      expect(client.getSnapshot().connection.status).toBe("left");
      expect(onLeft).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Unable");
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
        expect(container.textContent).toContain("The call ended");
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
