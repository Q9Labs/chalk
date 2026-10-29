import { afterEach, expect, it, vi } from "vitest";
import { capturedClient, mediaTrack } from "../../tests/helpers/media-convergence";
import { createCoreTestPlatform } from "./core.test.helpers";
import type { ConnectionSyncClient } from "../connection/dependencies";
import { ConnectionReporter, type ConnectionReport } from "../connection/report";

afterEach(() => vi.useRealTimers());
let reportSequence = 0;

function scenario(source: "microphone" | "camera" = "microphone", media: NonNullable<Parameters<typeof capturedClient>[2]>["media"] = {}) {
  const reportClockOffset = ++reportSequence * 120000;
  const base = createCoreTestPlatform();
  const reports: ConnectionReport[] = [];
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      clock: { ...base.dependencies.clock, setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds), clearTimeout: (timer) => globalThis.clearTimeout(timer) },
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
  const client = capturedClient(platform, track, { media, sync: { setMicrophoneEnabled: command, setCameraEnabled: command } });
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

it.each(["microphone", "camera"] as const)("fails closed when %s never reaches the class; a fresh tap enables playable media", async (source) => {
  const test = scenario(source);
  try {
    await test.join();
    expect(test.client.getSnapshot().media.local[source].state).toBe("requesting");
    expect(test.received.enabled).toBe(false);
    test.project(true);
    vi.useFakeTimers();
    test.project(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.client.getSnapshot().media.local[source].state).toBe("failed");
    expect(test.track.enabled).toBe(false);
    expect(test.received.enabled).toBe(false);
    expect(test.platform.sync.getSnapshot().media?.items[0]?.enabled).toBe(false);
    expect(test.command).not.toHaveBeenCalled();
    vi.useRealTimers();
    await (source === "microphone" ? test.client.media.setMicrophoneEnabled(true) : test.client.media.setCameraEnabled(true));
    expect(test.command).toHaveBeenCalledExactlyOnceWith(true);
    expect(test.client.getSnapshot().media.local[source].state).toBe("enabled");
    expect(test.observer.sync.getSnapshot().media?.items[0]?.enabled).toBe(true);
    expect(test.received.enabled).toBe(true);
    expect(test.received.readyState).toBe("live");
    expect(test.track.enabled).toBe(true);
  } finally {
    test.dispose();
  }
});

it("automatically reports a persistent mismatch once, with zero retries and no raw text", async () => {
  const test = scenario();
  try {
    await test.join();
    test.project(true);
    vi.useFakeTimers();
    test.project(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.reports).toHaveLength(1);
    expect(test.reports[0]?.trigger).toBe("media_projection_mismatch");
    expect(test.reports[0]?.events.at(-1)).toMatchObject({ event: "media_projection_mismatch", source: "microphone", publication_state: "on", projection_state: "off", attempt: 0, outcome: "failed" });
    expect(test.reports[0]?.events.at(-1)?.duration_ms).toBe(10000);
    expect(test.command).not.toHaveBeenCalled();
    expect(test.track.enabled).toBe(false);
  } finally {
    test.dispose();
  }
});

it.each(["microphone", "camera"] as const)("accepts a healthy %s confirmation just before the ten-second deadline", async (source) => {
  const test = scenario(source);
  try {
    await test.join();
    test.project(true);
    vi.useFakeTimers();
    test.project(false);
    await vi.advanceTimersByTimeAsync(9999);
    expect(test.track.enabled).toBe(true);
    expect(test.client.getSnapshot().media.local[source].state).toBe("requesting");
    expect(test.received.enabled).toBe(false);
    test.project(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(test.client.getSnapshot().media.local[source].state).toBe("enabled");
    expect(test.track.enabled).toBe(true);
    expect(test.received.enabled).toBe(true);
    expect(test.command).not.toHaveBeenCalled();
    expect(test.reports).toHaveLength(0);
  } finally {
    test.dispose();
  }
});

const lateConfirmationCases = (["microphone", "camera"] as const).flatMap((source) => (["during", "after"] as const).map((tap) => ({ source, tap })));

it.each(lateConfirmationCases)("closes only its own $source after a late confirmation and recovers with one tap $tap closure", async ({ source, tap }) => {
  let finishClose = () => {};
  const closing = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const close = vi.fn(async () => {
    await closing;
    test.project(false);
    test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, track: test.track, enabled: false }] });
  });
  const test = scenario(source, { closeForcedLocalPublication: close });
  try {
    await test.join();
    test.project(true);
    vi.useFakeTimers();
    test.project(false);
    await vi.advanceTimersByTimeAsync(10000);
    vi.useRealTimers();
    expect(test.client.getSnapshot().media.local[source].state).toBe("failed");
    expect(test.track.enabled).toBe(false);
    await vi.waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith(source));
    expect(test.track.enabled).toBe(false);
    expect(test.client.getSnapshot().media.local[source].state).toBe("failed");
    test.project(true);
    expect(test.track.enabled).toBe(false);
    expect(test.client.getSnapshot().media.local[source].state).toBe("failed");
    if (tap === "after") {
      finishClose();
      await close.mock.results[0]?.value;
      expect(test.command).not.toHaveBeenCalled();
      expect(test.track.enabled).toBe(false);
      expect(test.client.getSnapshot().media.local[source].state).toBe("failed");
      expect(test.observer.sync.getSnapshot().media?.items[0]?.enabled).toBe(false);
      expect(test.received.enabled).toBe(false);
    }
    const on = source === "microphone" ? test.client.media.setMicrophoneEnabled(true) : test.client.media.setCameraEnabled(true);
    if (tap === "during") {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(test.command).not.toHaveBeenCalled();
      finishClose();
    }
    await on;
    expect(test.command).toHaveBeenCalledExactlyOnceWith(true);
    expect(close).toHaveBeenCalledOnce();
    expect(test.track.enabled).toBe(true);
    expect(test.client.getSnapshot().media.local[source].state).toBe("enabled");
    expect(test.received.enabled).toBe(true);
    expect(test.reports).toHaveLength(1);
  } finally {
    finishClose();
    test.dispose();
  }
});

it.each(["mute", "ended"] as const)("pauses an iPadOS %s microphone locally without changing another client's projection", async (event) => {
  const test = scenario();
  try {
    await test.join();
    test.project(true);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    Object.assign(test.track, event === "mute" ? { muted: true } : { readyState: "ended" });
    test.track.dispatchEvent(new Event(event));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.track.enabled).toBe(false);
    Object.assign(test.track, { muted: false });
    test.track.dispatchEvent(new Event("unmute"));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.command).not.toHaveBeenCalled();
    // Receiver gating is still authoritative; it is not rewritten by local OS events.
    expect(test.observer.sync.getSnapshot().media?.items[0]?.enabled).toBe(true);
  } finally {
    test.dispose();
  }
});

it("applies a manual mute immediately, without waiting for the grace", async () => {
  const test = scenario();
  try {
    await test.join();
    const off = test.client.media.setMicrophoneEnabled(false);
    await vi.waitFor(() => expect(test.track.enabled).toBe(false));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    await off;
    expect(test.command).toHaveBeenCalledExactlyOnceWith(false);
    expect(test.received.enabled).toBe(false);
  } finally {
    test.dispose();
  }
});

it("uses the actual publication track for the local control after replacement", async () => {
  const test = scenario();
  try {
    await test.join();
    test.track.enabled = false;
    const replacement = mediaTrack();
    test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, track: replacement }] });
    test.project(true);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    expect(test.client.getSnapshot().media.local.microphone.track).toBe(replacement);
    const off = test.client.media.setMicrophoneEnabled(false);
    expect(replacement.enabled).toBe(false);
    await off;
    expect(test.command).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    test.dispose();
  }
});

it("keeps a mute action while live capture awaits Sync, and enforces mute on offline replacements", async () => {
  const test = scenario();
  try {
    await test.join();
    test.project(true);
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("reconnecting"));
    expect(test.track.enabled).toBe(true);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("requesting");
    await test.client.media.setMicrophoneEnabled(false);
    expect(test.track.enabled).toBe(false);
    const replacement = mediaTrack();
    test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, publicationId: "offline-replacement", track: replacement }] });
    expect(replacement.enabled).toBe(false);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.command).not.toHaveBeenCalled();
  } finally {
    test.dispose();
  }
});

it.each(["mute", "ended"] as const)("watches OS %s on the actual replacement microphone, not a retired capture", async (event) => {
  const test = scenario();
  try {
    await test.join();
    const replacement = mediaTrack();
    test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, track: replacement }] });
    test.project(true);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
    Object.assign(replacement, event === "mute" ? { muted: true } : { readyState: "ended" });
    replacement.dispatchEvent(new Event(event));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(replacement.enabled).toBe(false);
    Object.assign(replacement, { muted: false });
    replacement.dispatchEvent(new Event("unmute"));
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.command).not.toHaveBeenCalled();
  } finally {
    test.dispose();
  }
});

it("does not automatically send cleanup after a rejected enable", async () => {
  const test = scenario();
  try {
    await test.join();
    await test.client.media.setMicrophoneEnabled(false);
    test.command.mockImplementationOnce(async () => {
      test.track.enabled = true;
      test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, track: test.track }] });
      test.project(true);
      throw new Error("private provider message");
    });
    await expect(test.client.media.setMicrophoneEnabled(true)).rejects.toThrow();
    expect(test.track.enabled).toBe(false);
    expect(test.client.getSnapshot().media.local.microphone.state).not.toBe("enabled");
    test.project(false);
    vi.useFakeTimers();
    test.project(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.command.mock.calls.map(([enabled]) => enabled)).toEqual([false, true]);
    expect(test.reports.at(-1)?.events.at(-1)).toMatchObject({ publication_state: "off", projection_state: "on", attempt: 0 });
    expect(JSON.stringify(test.reports)).not.toContain("private provider");
  } finally {
    test.dispose();
  }
});

it("preserves a recovered host stop until fresh consent", async () => {
  const test = scenario();
  try {
    await test.join();
    test.project(true);
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "recovering" } });
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("reconnecting"));
    test.project(false);
    test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "live" } });
    await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("live"));
    expect(test.track.enabled).toBe(false);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    expect(test.command).not.toHaveBeenCalled();
    await test.client.media.setMicrophoneEnabled(true);
    expect(test.command).toHaveBeenCalledExactlyOnceWith(true);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("enabled");
  } finally {
    test.dispose();
  }
});

it.each(["microphone", "camera"] as const)("never resumes failed %s capture or sends repairs as publications churn", async (source) => {
  const test = scenario(source);
  try {
    await test.join();
    test.project(true);
    vi.useFakeTimers();
    for (let i = 0; i < 20; ++i) {
      const replacement = Object.assign(mediaTrack(), { kind: test.track.kind });
      test.platform.media.emit({ ...test.platform.media.getSnapshot(), localTracks: [{ ...test.publication, publicationId: `replacement-${i}`, track: replacement }] });
      await vi.advanceTimersByTimeAsync(1000);
      if (i >= 9) expect(replacement.enabled).toBe(false);
    }
    expect(test.client.getSnapshot().media.local[source].state).toBe("failed");
    expect(test.track.enabled).toBe(false);
    // Round-one P1: receiver's stale gate may be on, but this capture must be off.
    expect(test.received.enabled).toBe(true);
    expect(test.command).not.toHaveBeenCalled();
    expect(test.reports).toHaveLength(1);
    expect(test.reports[0]?.events.at(-1)).toMatchObject({ publication_state: "on", projection_state: "on", duration_ms: 10000, attempt: 0, outcome: "failed" });
  } finally {
    vi.useRealTimers();
    test.dispose();
  }
});

it("reports off/on drift while a manual mute is pending without sending an extra command", async () => {
  const test = scenario();
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
    const off = test.client.media.setMicrophoneEnabled(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.reports).toHaveLength(1);
    expect(test.reports[0]?.events.at(-1)).toMatchObject({ publication_state: "off", projection_state: "on", duration_ms: 10000, attempt: 0 });
    expect(test.command).toHaveBeenCalledExactlyOnceWith(false);
    expect(test.client.getSnapshot().media.local.microphone.state).toBe("disabled");
    finish();
    await off;
  } finally {
    finish();
    vi.useRealTimers();
    test.dispose();
  }
});
