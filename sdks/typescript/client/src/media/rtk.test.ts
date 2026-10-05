import { describe, expect, it, vi } from "vitest";
import type { MediaSource } from "./plane";
import type { ParticipantMediaAccess } from "../access/grant";
import { CloudflareRTKClient, type CloudflareRTKConnection } from "./rtk";

describe("RealtimeKit recovery ownership", () => {
  it.each(
    (["microphone", "camera", "screen"] as const).flatMap((source) =>
      (source === "screen" ? ["enable", "disable"] : ["enable", "disable", "start"]).flatMap((operation) => (operation === "disable" ? ["clear", "restart", "stop"] : ["clear", "restart", "stop", "clear_error"]).map((retire) => ({ source, operation, retire }))),
    ),
  )("settles $source $operation after $retire without leaving a late publication", async ({ source, operation, retire }) => {
    const { initial, client, target } = await preparedSource(source, operation === "disable", operation !== "start");
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enableMethod = source === "microphone" ? "enableAudio" : source === "camera" ? "enableVideo" : "enableScreenShare";
    const disableMethod = source === "microphone" ? "disableAudio" : source === "camera" ? "disableVideo" : "disableScreenShare";
    const disable = vi.spyOn(initial.self, disableMethod);
    if (retire === "clear_error") disable.mockRejectedValueOnce(new Error("compensation failed"));
    const enable = vi.spyOn(initial.self, operation === "disable" ? disableMethod : enableMethod).mockImplementationOnce(() => pending);
    const enabling =
      operation === "start"
        ? client.start({ getTracks: () => [] } as unknown as MediaStream).then(
            () => ({ outcome: "started" }),
            () => ({ outcome: "failed" }),
          )
        : client.setLocalPublicationTarget({ ...target, enabled: operation === "enable" });
    await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce());
    let cleared = false;
    const clearing = client.clearPreparedLocalTrack(source).then(() => {
      cleared = true;
    });
    try {
      if (operation !== "disable") await vi.waitFor(() => expect(cleared).toBe(true));
      if (retire === "restart") await client.restart(access("replacement"));
      if (retire === "stop") client.stop();
      release();
      await vi.waitFor(() => expect(cleared).toBe(true));
      expect(await enabling).toMatchObject({ outcome: operation === "start" ? (retire === "clear_error" ? "failed" : "started") : operation === "disable" && retire === "clear" ? "confirmed" : "retryable_failure" });
      await vi.waitFor(() => expect(disable).toHaveBeenCalled());
      if (retire === "stop") expect(client.getSnapshot().connection.phase).toBe("stopped");
      else {
        expect(client.getSnapshot().localTracks).toEqual([]);
        expect(client.getSnapshot().connection.phase).toBe(retire === "clear_error" ? "failed" : "live");
      }
    } finally {
      release();
      await Promise.allSettled([enabling, clearing]);
      client.stop();
    }
  });
  it.each(["disable", "clear"] as const)("applies %s truthfully after concurrent recovery", async (intent) => {
    const source = "microphone";
    const { initial, replacement, client, target } = await preparedSource(source);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const method = "disableAudio";
    const disable = vi.spyOn(initial.self, method).mockImplementationOnce(() => pending);
    const oldTarget = intent === "clear" ? client.clearPreparedLocalTrack(source) : client.setLocalPublicationTarget({ ...target, enabled: false });
    await vi.waitFor(() => expect(disable).toHaveBeenCalledOnce());
    const currentDisable = vi.spyOn(replacement.self, method);
    await client.restart(access("replacement"));
    release();
    if (intent === "clear") {
      await oldTarget;
      expect(client.getSnapshot().localTracks).toEqual([]);
      expect(currentDisable).toHaveBeenCalledOnce();
      client.stop();
      return;
    }
    expect(await oldTarget).toMatchObject({ outcome: "retryable_failure" });
    expect(await client.setLocalPublicationTarget({ ...target, enabled: false })).toMatchObject({ outcome: "confirmed" });
    expect(currentDisable).toHaveBeenCalledOnce();
    expect(client.getSnapshot().localTracks[0]?.enabled).toBe(false);
    client.stop();
  });

  it.each(["microphone", "camera", "screen"] as const)("keeps a confirmed %s mute off when restoration finishes later", async (source) => {
    const { replacement, client, track, target } = await preparedSource(source);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const method = source === "microphone" ? "enableAudio" : source === "camera" ? "enableVideo" : "enableScreenShare";
    const restore = vi.spyOn(replacement.self, method).mockImplementationOnce(() => pending);
    try {
      const recovery = client.restart(access("replacement"));
      await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
      const mute = client.setLocalPublicationTarget({ ...target, enabled: false });
      await Promise.resolve();
      await Promise.resolve();
      release();
      await recovery;
      expect(await mute).toMatchObject({ outcome: "confirmed" });
      expect(client.getSnapshot().localTracks[0]?.enabled).toBe(false);
      expect(track.enabled).toBe(false);
    } finally {
      release();
      client.stop();
    }
  });

  it.each(["leave", "factory", "join"] as const)("ignores a superseded restart waiting for %s", async (stage) => {
    const initial = connection();
    const stale = connection();
    const replacement = connection();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    // Only the browser stream's empty track list is needed for this adapter test.
    await client.start({ getTracks: () => [] } as unknown as MediaStream);
    const oldRestart = client.restart(access("stale"));
    await vi.waitFor(() => {
      if (stage === "factory") expect(factory).toHaveBeenCalledWith(expect.objectContaining({ authToken: "stale" }));
      else expect(stage === "leave" ? initial.leave : stale.join).toHaveBeenCalled();
    });
    await client.restart(access("replacement"));
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
  return {
    self: {
      peerId: "peer",
      audioEnabled: false,
      videoEnabled: false,
      screenShareEnabled: false,
      audioTrack: null,
      videoTrack: null,
      screenShareTracks: {},
      enableAudio: async () => {},
      enableVideo: async () => {},
      enableScreenShare: async () => {},
      disableAudio: async () => {},
      disableVideo: async () => {},
      disableScreenShare: async () => {},
      onAudioUpdate: observe,
      onVideoUpdate: observe,
      onScreenShareUpdate: observe,
      onLeft: observe,
    },
    participants: { joined: { list: () => [], onJoined: observe, onLeft: observe } },
    join: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
  } satisfies CloudflareRTKConnection;
}
