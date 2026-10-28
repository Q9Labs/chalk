import { afterEach, expect, it, vi } from "vitest";
import { capturedClient, mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform } from "./core.test.helpers";
import type { ConnectionSyncClient } from "../connection/dependencies";
import { ConnectionReporter, type ConnectionReport } from "../connection/report";

afterEach(() => vi.useRealTimers());

function scenario() {
  const base = createCoreTestPlatform();
  const reports: ConnectionReport[] = [];
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      createConnectionReporter: (access: ConstructorParameters<typeof ConnectionReporter>[0]["access"]) =>
        new ConnectionReporter({
          access,
          now: Date.now,
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
          online: () => true,
          subscribeOnline: () => () => {},
          send: async (_access, report) => {
            reports.push(report);
          },
        }),
    },
  };
  const track = mediaTrack();
  const received = mediaTrack();
  const observer = createCoreTestPlatform();
  const publication = { participantId: "participant-1", source: "microphone" as const, enabled: true, publicationId: "audio-1" };
  const project = (enabled: boolean) => {
    const media = { projectionId: "media", sequence: 1, items: [{ ...publication, enabled }] };
    platform.emitSync({ ...platform.sync.getSnapshot(), media });
    observer.emitSync({ ...observer.sync.getSnapshot(), media });
  };
  const command = vi.fn<ConnectionSyncClient["setMicrophoneEnabled"]>(async (enabled) => {
    track.enabled = enabled;
    platform.media.emit({ ...platform.media.getSnapshot(), localTracks: [{ ...publication, enabled, track }] });
    project(enabled);
    return { operationId: "repair", name: "set_microphone_enabled", serverOutcome: "satisfied", mediaPlaneOutcome: "satisfied" };
  });
  const client = capturedClient(platform, track, { sync: { setMicrophoneEnabled: command } });
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
      await client.join({ microphone: true, camera: false });
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
    await vi.waitFor(() => expect(test.command).toHaveBeenCalledExactlyOnceWith(true), { timeout: 2000 });
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
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    await off;
    expect(test.command).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    test.dispose();
  }
});

it("reconciles again after a Sync reconnect instead of revoking a healthy publication", async () => {
  const test = scenario();
  try {
    await test.join();
    test.project(true);
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("reconnecting"));
    test.project(false);
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "live" } });
    await vi.waitFor(() => expect(test.command).toHaveBeenCalledExactlyOnceWith(true), { timeout: 2000 });
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    expect(test.received.enabled).toBe(true);
  } finally {
    test.dispose();
  }
});
