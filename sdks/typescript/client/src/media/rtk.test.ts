import { describe, expect, it, vi } from "vitest";
import type { MediaSource } from "./plane";
import type { ParticipantMediaAccess } from "../access/grant";
import { CloudflareRTKClient, type CloudflareRTKConnection } from "./rtk";

describe("RealtimeKit recovery ownership", () => {
  it.each((["microphone", "camera", "screen", "start"] as const).flatMap((mode) => ["clear", "restart", "stop", "clear_error"].map((retire) => ({ mode, retire }))))("compensates a late $mode enable after $retire", async ({ mode, retire }) => {
    const source = mode === "start" ? "microphone" : mode;
    const { initial, client, target } = await preparedSource(source, false, mode !== "start");
    const { pending, release } = pendingOperation();
    const enableMethod = source === "microphone" ? "enableAudio" : source === "camera" ? "enableVideo" : "enableScreenShare";
    const disableMethod = source === "microphone" ? "disableAudio" : source === "camera" ? "disableVideo" : "disableScreenShare";
    const disable = vi.spyOn(initial.self, disableMethod);
    if (retire === "clear_error") disable.mockRejectedValueOnce(new Error("compensation failed"));
    const enable = vi.spyOn(initial.self, enableMethod).mockImplementationOnce(() => pending);
    const enabling =
      mode === "start"
        ? client.start({ getTracks: () => [] } as unknown as MediaStream).then(
            () => "started",
            () => "failed",
          )
        : client.setLocalPublicationTarget({ ...target, enabled: true });
    let settled = false;
    void enabling.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce());
    const cleared = vi.fn();
    const clearing = client.clearPreparedLocalTrack(source).then(cleared);
    try {
      await vi.waitFor(() => expect(cleared).toHaveBeenCalledOnce());
      if (retire === "restart") await client.restart(access("replacement"));
      if (retire === "stop") client.stop();
      if (retire === "restart" || retire === "stop") await vi.waitFor(() => expect(settled).toBe(true));
      release();
      expect(await enabling).toEqual(mode === "start" ? (retire === "clear_error" ? "failed" : "started") : expect.objectContaining({ outcome: "retryable_failure" }));
      await vi.waitFor(() => expect(disable).toHaveBeenCalled());
      if (retire === "clear_error") expect(client.getSnapshot().connection.phase).toBe("failed");
    } finally {
      release();
      await Promise.allSettled([enabling, clearing]);
      client.stop();
    }
  });
  it.each(["disable", "clear"] as const)("applies %s truthfully during replacement", async (intent) => {
    const { initial, replacement, client, target, track } = await preparedSource("microphone");
    const { pending, release } = pendingOperation();
    const action = vi.spyOn(initial.self, "disableAudio").mockImplementationOnce(() => pending);
    const oldTarget = intent === "clear" ? client.clearPreparedLocalTrack("microphone") : client.setLocalPublicationTarget({ ...target, enabled: false });
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    const currentDisable = vi.spyOn(replacement.self, "disableAudio");
    try {
      await client.restart(access("replacement"));
      release();
      const result = await oldTarget;
      if (intent === "clear") {
        expect(client.getSnapshot().localTracks).toEqual([]);
        expect(currentDisable).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ outcome: "retryable_failure" });
        expect(await client.setLocalPublicationTarget({ ...target, enabled: false })).toMatchObject({ outcome: "confirmed" });
        expect(currentDisable).toHaveBeenCalledOnce();
        expect(track.enabled).toBe(false);
      }
    } finally {
      release();
      client.stop();
    }
  });

  it.each(["mute", "clear"] as const)("preserves %s intent across two-source restoration", async (intent) => {
    const { replacement, client } = await preparedSource("microphone");
    const camera = Object.assign(new EventTarget(), { kind: "video", enabled: true }) as MediaStreamTrack;
    const target = { operationId: "camera", participantId: "participant", source: "camera", enabled: true } as const;
    client.prepareLocalTrack("camera", camera);
    await client.setLocalPublicationTarget(target);
    const restore = pendingOperation();
    const disable = pendingOperation();
    const method = intent === "mute" ? "enableAudio" : "enableVideo";
    const enable = replacement.self[method];
    const restoring = vi.spyOn(replacement.self, method).mockImplementationOnce(async () => {
      await restore.pending;
      await enable();
    });
    const disableCamera = vi.spyOn(replacement.self, "disableVideo");
    if (intent === "mute") disableCamera.mockImplementationOnce(() => disable.pending);
    const recovery = client.restart(access("replacement"));
    await vi.waitFor(() => expect(restoring).toHaveBeenCalledOnce());
    try {
      if (intent === "mute") {
        const mute = client.setLocalPublicationTarget({ ...target, enabled: false });
        await vi.waitFor(() => expect(disableCamera).toHaveBeenCalledOnce());
        restore.release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        disable.release();
        expect(await mute).toMatchObject({ outcome: "confirmed" });
      } else await client.clearPreparedLocalTrack("microphone");
      restore.release();
      await recovery;
      expect(intent === "mute" ? replacement.self.videoEnabled : replacement.self.audioEnabled).toBe(false);
      if (intent === "mute") expect(camera.enabled).toBe(false);
    } finally {
      restore.release();
      disable.release();
      client.stop();
    }
  });

  it.each(["leave", "factory", "join"] as const)("ignores a superseded restart waiting for %s", async (stage) => {
    const initial = connection();
    const stale = connection();
    const replacement = connection();
    const { pending, release } = pendingOperation();
    if (stage === "leave") initial.leave.mockImplementationOnce(() => pending);
    if (stage === "join") stale.join.mockImplementationOnce(() => pending);
    const factory = vi.fn(async ({ authToken }: { readonly authToken: string }) => {
      if (authToken === "initial") return initial;
      if (authToken === "stale") {
        if (stage === "factory") await pending;
        return stale;
      }
      return replacement;
    });
    const client = new CloudflareRTKClient({ authToken: "initial", participantId: "participant", clientFactory: factory });
    const track = Object.assign(new EventTarget(), { kind: "audio", enabled: false }) as MediaStreamTrack;
    client.prepareLocalTrack("microphone", track);
    await client.start({ getTracks: () => [] } as unknown as MediaStream);
    const oldRestart = client.restart(access("stale"));
    await vi.waitFor(() => {
      if (stage === "factory") expect(factory).toHaveBeenCalledWith(expect.objectContaining({ authToken: "stale" }));
      else expect(stage === "leave" ? initial.leave : stale.join).toHaveBeenCalled();
    });
    vi.spyOn(stage === "join" ? stale.self : initial.self, "disableAudio").mockRejectedValue(new Error("retiring provider"));
    expect(
      await client.clearPreparedLocalTrack("microphone").then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(client.getSnapshot().localTracks).toEqual([]);
    const restore = vi.spyOn(replacement.self, "enableAudio");
    await client.restart(access("replacement"));
    expect(restore).not.toHaveBeenCalled();
    if (stage === "join") client.stop();
    release();
    await oldRestart;
    expect(client.getSnapshot().connection.phase).toBe(stage === "join" ? "stopped" : "live");
    expect(stale.join).toHaveBeenCalledTimes(stage === "join" ? 1 : 0);
    client.stop();
    await Promise.resolve();
    expect(replacement.leave).toHaveBeenCalledOnce();
    expect(stale.leave).toHaveBeenCalledTimes(stage === "leave" ? 0 : stage === "join" ? 2 : 1);
  });
});

function access(token: string): ParticipantMediaAccess {
  return { provider: "cloudflare_rtk", token, expiresAt: "2030-01-01T00:00:00Z", clientPayload: { token, providerSubject: "participant" } };
}

async function preparedSource(source: MediaSource, enabled = true, started = true) {
  const initial = connection();
  const replacement = connection();
  const client = new CloudflareRTKClient({ authToken: "initial", participantId: "participant", clientFactory: async ({ authToken }) => (authToken === "initial" ? initial : replacement) });
  if (started) await client.start({ getTracks: () => [] } as unknown as MediaStream);
  const track = Object.assign(new EventTarget(), { kind: source === "microphone" ? "audio" : "video", enabled: true, stop: () => {} });
  client.prepareLocalTrack(source, track as unknown as MediaStreamTrack);
  const target = { operationId: "privacy", participantId: "participant", source, enabled: true };
  if (enabled) await client.setLocalPublicationTarget(target);
  return { initial, replacement, client, track, target };
}

function connection() {
  const observe = () => () => {};
  const self = {
    peerId: "peer",
    audioEnabled: false,
    videoEnabled: false,
    screenShareEnabled: false,
    audioTrack: null,
    videoTrack: null,
    screenShareTracks: {},
    enableAudio: async () => {
      self.audioEnabled = true;
    },
    enableVideo: async () => {
      self.videoEnabled = true;
    },
    enableScreenShare: async () => {
      self.screenShareEnabled = true;
    },
    disableAudio: async () => {
      self.audioEnabled = false;
    },
    disableVideo: async () => {
      self.videoEnabled = false;
    },
    disableScreenShare: async () => {
      self.screenShareEnabled = false;
    },
    onAudioUpdate: observe,
    onVideoUpdate: observe,
    onScreenShareUpdate: observe,
    onLeft: observe,
  };
  return { self, participants: { joined: { list: () => [], onJoined: observe, onLeft: observe } }, join: vi.fn(async () => {}), leave: vi.fn(async () => {}) } satisfies CloudflareRTKConnection;
}

function pendingOperation() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}
