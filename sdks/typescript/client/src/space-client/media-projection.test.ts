import { afterEach, expect, it, vi } from "vitest";
import { capturedClient, mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform } from "./core.test.helpers";
import type { ConnectionSyncClient } from "../connection/dependencies";
import { ConnectionReporter, type ConnectionReport } from "../connection/report";

afterEach(() => vi.useRealTimers());
let reportSequence = 0;

function scenario(source: "microphone" | "camera" = "microphone") {
  const reportClockOffset = ++reportSequence * 120000;
  const base = createCoreTestPlatform();
  const reports: ConnectionReport[] = [];
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      createConnectionReporter: (access: ConstructorParameters<typeof ConnectionReporter>[0]["access"]) =>
        new ConnectionReporter({
          access,
          now: () => Date.now() + reportClockOffset,
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
          online: () => true,
          subscribeOnline: () => () => {},
          send: async (_access, report) => {
            reports.push(report);
          },
        }),
    },
  };
  const track = Object.assign(mediaTrack(), { kind: source === "microphone" ? "audio" : "video" });
  const received = Object.assign(mediaTrack(), { kind: track.kind });
  const observer = createCoreTestPlatform();
  const publication = { participantId: "participant-1", source, enabled: true, publicationId: "publication-1" };
  const project = (enabled: boolean) => {
    const media = { projectionId: "media", sequence: 1, items: [{ ...publication, enabled }] };
    platform.emitSync({ ...platform.sync.getSnapshot(), media });
    observer.emitSync({ ...observer.sync.getSnapshot(), media });
  };
  const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>(async (enabled) => {
    track.enabled = enabled;
    platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, enabled, track }] });
    project(enabled);
    return { operationId: "repair", name: source === "microphone" ? "set_microphone_enabled" : "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
  });
  const client = capturedClient(platform, track, { sync: { setMicrophoneEnabled: command, setCameraEnabled: command } });
  const peer = capturedClient(observer, mediaTrack());
  return {
    reports,
    platform,
    track,
    received,
    observer,
    publication,
    project,
    command,
    client,
    peer,
    join: async () => {
      await peer.join({ microphone: false, camera: false });
      await client.join({ microphone: source === "microphone", camera: source === "camera" });
      project(false);
      observer.media.emit({ ...observer.media.getSnapshot(), remoteTracks: [{ ...publication, track: received }] });
      platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, track }] });
    },
    dispose: () => {
      client.dispose();
      peer.dispose();
    },
  };
}

it("repairs an enabled publication stuck muted in Sync and opens the receiver audio gate", async () => {
  const test = scenario();
  try {
    await test.join();
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("requesting");
    expect(test.received.enabled).toBe(false);
    await vi.waitFor(() => expect(test.command).toHaveBeenCalledExactlyOnceWith(true, { signal: expect.any(AbortSignal) }), { timeout: 2000 });
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    expect(test.platform.sync.getSnapshot().media?.items[0]?.enabled).toBe(true);
    expect(test.observer.sync.getSnapshot().media?.items[0]?.enabled).toBe(true);
    expect(test.received.enabled).toBe(true);
    expect(test.received.readyState).toBe("live");
    expect(test.track.enabled).toBe(true);
  } finally {
    test.dispose();
  }
});

it("automatically reports a persistent mismatch through the connection reporter", async () => {
  const test = scenario();
  test.command.mockResolvedValue({ operationId: "stale", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
  try {
    await test.join();
    await vi.waitFor(() => expect(test.reports).toHaveLength(1), { timeout: 4000 });
    expect(test.reports[0]?.trigger).toBe("media_projection_mismatch");
    expect(test.reports[0]?.events.at(-1)).toMatchObject({ event: "media_projection_mismatch", source: "microphone", publication_state: "on", projection_state: "off", attempt: 2, outcome: "started" });
    expect(test.reports[0]?.events.at(-1)?.duration_ms).toBeGreaterThanOrEqual(2000);
    await vi.waitFor(() => expect(test.client.getSnapshot().media.local.microphone.state).toBe("failed"), { timeout: 2000 });
    expect(test.command).toHaveBeenCalledTimes(3);
    expect(test.received.enabled).toBe(false);
  } finally {
    test.dispose();
  }
});

it.each(["mute", "ended"] as const)("turns an iPadOS %s mic off on both sides, never advertising a dead source", async (event) => {
  const test = scenario();
  try {
    await test.join();
    test.project(true);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    if (event === "mute") Object.assign(test.track, { muted: true });
    else Object.assign(test.track, { readyState: "ended" });
    test.track.dispatchEvent(new Event(event));
    expect(test.client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
    await vi.waitFor(() => expect(test.command).toHaveBeenCalledExactlyOnceWith(false));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.received.enabled).toBe(false);
    Object.assign(test.track, { muted: false });
    test.track.dispatchEvent(new Event("unmute"));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    // Resuming an interrupted browser source requires an explicit user unmute.
    expect(test.command).toHaveBeenCalledTimes(1);
  } finally {
    test.dispose();
  }
});

it("does not wait for reconciliation to apply a manual mute", async () => {
  const test = scenario();
  try {
    await test.join();
    const off = test.client.media.setMicrophoneEnabled(false);
    await vi.waitFor(() => expect(test.track.enabled).toBe(false));
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("live"));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    await off;
    expect(test.command).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    test.dispose();
  }
});

it("keeps a rejected enable unconfirmed until failed-command cleanup converges it off", async () => {
  const test = scenario();
  try {
    await test.join();
    await test.client.media.setMicrophoneEnabled(false);
    test.command.mockImplementationOnce(async () => {
      test.track.enabled = true;
      test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, track: test.track }] });
      throw new Error("lost acknowledgement");
    });
    await expect(test.client.media.setMicrophoneEnabled(true)).rejects.toThrow();
    expect(test.client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
    expect(test.received.enabled).toBe(false);
    await vi.waitFor(() => expect(test.command.mock.calls).toEqual([[false], [true], [false]]));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.platform.sync.getSnapshot().media?.items[0]?.enabled).toBe(false);
    expect(test.track.enabled).toBe(false);
    expect(test.received.enabled).toBe(false);
    expect(test.command).toHaveBeenCalledTimes(3);
  } finally {
    test.dispose();
  }
});

it("retries rejected enable cleanup toward off without republishing audio", async () => {
  const test = scenario();
  try {
    await test.join();
    await test.client.media.setMicrophoneEnabled(false);
    test.command.mockImplementationOnce(async () => {
      test.track.enabled = true;
      test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, track: test.track }] });
      test.project(true);
      throw new Error("lost acknowledgement");
    });
    test.command.mockRejectedValueOnce(new Error("cleanup rejected"));
    await expect(test.client.media.setMicrophoneEnabled(true)).rejects.toThrow();
    expect(test.track.enabled).toBe(false);
    expect(test.client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
    await vi.waitFor(() => expect(test.command.mock.calls.map(([enabled]) => enabled)).toEqual([false, true, false, false]), { timeout: 2000 });
    expect(test.command).toHaveBeenLastCalledWith(false, { signal: expect.any(AbortSignal) });
    expect(test.platform.sync.getSnapshot().media?.items[0]?.enabled).toBe(false);
    expect(test.received.enabled).toBe(false);
  } finally {
    test.dispose();
  }
});

it("preserves a moderation stop recovered through a full Sync snapshot until a fresh user action", async () => {
  const test = scenario();
  try {
    await test.join();
    test.project(true);
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("reconnecting"));
    test.project(false);
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "live" } });
    await vi.waitFor(() => expect(test.track.enabled).toBe(false));
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("live"));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.command).not.toHaveBeenCalled();
    await test.client.media.setMicrophoneEnabled(true);
    expect(test.command).toHaveBeenCalledExactlyOnceWith(true);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    expect(test.received.enabled).toBe(true);
  } finally {
    test.dispose();
  }
});

it("reconciles publication identity after reconnect when recovery still confirms enabled consent", async () => {
  const test = scenario();
  try {
    await test.join();
    test.project(true);
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("reconnecting"));
    test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, publicationId: "replacement", track: test.track }] });
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "live" } });
    await vi.waitFor(() => expect(test.command).toHaveBeenCalledExactlyOnceWith(true, { signal: expect.any(AbortSignal) }), { timeout: 2000 });
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    expect(test.received.enabled).toBe(true);
  } finally {
    test.dispose();
  }
});

it("releases an expired repair so a manual retry and mute do not wait for its late completion", async () => {
  const test = scenario();
  const schedule = vi.spyOn(test.platform.dependencies.clock, "setTimeout").mockImplementation((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
  let finish = () => {};
  try {
    await test.join();
    test.project(true);
    vi.useFakeTimers();
    test.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ operationId: "late", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
        }),
    );
    test.project(false);
    await vi.advanceTimersByTimeAsync(8750);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("failed");
    expect(test.command.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
    const retry = test.client.media.setMicrophoneEnabled(true);
    await vi.waitFor(() => expect(test.command).toHaveBeenCalledTimes(2));
    await retry;
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    await test.client.media.setMicrophoneEnabled(false);
    finish();
    await Promise.resolve();
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.received.enabled).toBe(false);
  } finally {
    finish();
    test.dispose();
    schedule.mockRestore();
  }
});

it.each(["microphone", "camera"] as const)("fails closed when a live %s publication cannot converge", async (source) => {
  const test = scenario(source);
  const schedule = vi.spyOn(test.platform.dependencies.clock, "setTimeout").mockImplementation((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
  try {
    await test.join();
    test.project(true);
    test.command.mockResolvedValue({ operationId: "stale", name: source === "microphone" ? "set_microphone_enabled" : "set_camera_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
    vi.useFakeTimers();
    // A live replacement publication exists while Sync still names the old one.
    test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, publicationId: "audio-replacement", track: test.track }] });
    test.observer.media.emit({ ...test.observer.media.getSnapshot(), remoteTracks: [{ ...test.publication, publicationId: "audio-replacement", track: test.received }] });
    await vi.advanceTimersByTimeAsync(3750);
    expect(test.command).toHaveBeenCalledTimes(3);
    expect(test.client.getSnapshot().media.local[source].state).toBe("failed");
    expect(test.observer.sync.getSnapshot().media?.items[0]?.enabled).toBe(true);
    expect(test.received.enabled).toBe(true);
    expect(test.track.enabled, "off-looking failed control must not keep transmitting").toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.command).toHaveBeenCalledTimes(3);
    expect(test.client.getSnapshot().media.local[source].state).toBe("failed");
    expect(test.track.enabled).toBe(false);
  } finally {
    vi.useRealTimers();
    test.dispose();
    schedule.mockRestore();
  }
});

it("automatically reports an off publication stuck on in Sync even while the mute command is pending", async () => {
  const test = scenario();
  const schedule = vi.spyOn(test.platform.dependencies.clock, "setTimeout").mockImplementation((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
  let finish = () => {};
  try {
    await test.join();
    test.project(true);
    vi.useFakeTimers();
    test.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ operationId: "pending", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" });
        }),
    );
    void test.client.media.setMicrophoneEnabled(false).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2750);
    expect(test.reports).toHaveLength(1);
    expect(test.reports[0]?.events.at(-1)).toMatchObject({ event: "media_projection_mismatch", source: "microphone", publication_state: "off", projection_state: "on", duration_ms: 2750, attempt: 0 });
    expect(test.command).toHaveBeenCalledExactlyOnceWith(false);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
  } finally {
    finish();
    test.dispose();
    schedule.mockRestore();
  }
});
