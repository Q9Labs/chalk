import { describe, expect, it, vi } from "vitest";
import type { MediaPublication } from "./plane";
import type { ParticipantMediaAccess } from "../access/grant";
import { CloudflareRTKClient, type CloudflareRTKConnection } from "./rtk";

describe("RealtimeKit recovery ownership", () => {
  it.each(["microphone", "camera", "screen"] as const)("does not confirm a stale %s disable before the replacement applies it", async (source) => {
    const initial = connection();
    const replacement = connection();
    const client = new CloudflareRTKClient({ authToken: "initial", participantId: "participant", clientFactory: async ({ authToken }) => (authToken === "initial" ? initial : replacement) });
    await client.start({ getTracks: () => [] } as unknown as MediaStream);
    const track = Object.assign(new EventTarget(), { kind: source === "microphone" ? "audio" : "video", enabled: true, stop: () => {} });
    client.prepareLocalTrack(source, track as unknown as MediaStreamTrack);
    const target = { operationId: "privacy", participantId: "participant", source, enabled: true };
    await client.setLocalPublicationTarget(target);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const method = source === "microphone" ? "disableAudio" : source === "camera" ? "disableVideo" : "disableScreenShare";
    const disable = vi.spyOn(initial.self, method).mockImplementationOnce(() => pending);
    const oldTarget = client.setLocalPublicationTarget({ ...target, enabled: false });
    await vi.waitFor(() => expect(disable).toHaveBeenCalledOnce());
    await client.restart(access("replacement"));
    release();
    expect(await oldTarget).toMatchObject({ outcome: "retryable_failure" });
    const currentDisable = vi.spyOn(replacement.self, method);
    expect(await client.setLocalPublicationTarget({ ...target, enabled: false })).toMatchObject({ outcome: "confirmed" });
    expect(currentDisable).toHaveBeenCalledOnce();
    expect(client.getSnapshot().localTracks[0]?.enabled).toBe(false);
    client.stop();
  });

  it("applies a new mute without waiting for an old connection's hung queue", async () => {
    const initial = connection();
    const replacement = connection();
    const client = new CloudflareRTKClient({ authToken: "initial", participantId: "participant", clientFactory: async ({ authToken }) => (authToken === "initial" ? initial : replacement) });
    await client.start({ getTracks: () => [] } as unknown as MediaStream);
    const track = Object.assign(new EventTarget(), { kind: "audio", enabled: true, stop: () => {} });
    client.prepareLocalTrack("microphone", track as unknown as MediaStreamTrack);
    const target = { operationId: "privacy", participantId: "participant", source: "microphone" as const, enabled: true };
    await client.setLocalPublicationTarget(target);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldDisable = vi.spyOn(initial.self, "disableAudio").mockImplementationOnce(() => pending);
    const oldMute = client.setLocalPublicationTarget({ ...target, enabled: false });
    await vi.waitFor(() => expect(oldDisable).toHaveBeenCalledOnce());
    const queuedEnable = client.setLocalPublicationTarget(target);
    const currentDisable = vi.spyOn(replacement.self, "disableAudio");
    try {
      await client.restart(access("replacement"));
      const mute = client.setLocalPublicationTarget({ ...target, enabled: false });
      await vi.waitFor(() => expect(currentDisable).toHaveBeenCalledOnce());
      expect(await mute).toMatchObject({ outcome: "confirmed" });
      release();
      expect(await oldMute).toMatchObject({ outcome: "retryable_failure" });
      expect(await queuedEnable).toMatchObject({ outcome: "retryable_failure" });
      expect(client.getSnapshot().localTracks[0]?.enabled).toBe(false);
    } finally {
      release();
      client.stop();
    }
  });

  it.each(["microphone", "camera", "screen"] as const)("keeps a confirmed %s mute off when restoration finishes later", async (source) => {
    const initial = connection();
    const replacement = connection();
    const client = new CloudflareRTKClient({ authToken: "initial", participantId: "participant", clientFactory: async ({ authToken }) => (authToken === "initial" ? initial : replacement) });
    await client.start({ getTracks: () => [] } as unknown as MediaStream);
    const track = Object.assign(new EventTarget(), { kind: source === "microphone" ? "audio" : "video", enabled: true, stop: () => {} });
    client.prepareLocalTrack(source, track as unknown as MediaStreamTrack);
    const target = { operationId: "privacy", participantId: "participant", source, enabled: true };
    await client.setLocalPublicationTarget(target);
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

  it("rechecks a queued target after its prepared track was removed", async () => {
    const initial = connection();
    const client = new CloudflareRTKClient({ authToken: "initial", participantId: "participant", clientFactory: async () => initial });
    await client.start({ getTracks: () => [] } as unknown as MediaStream);
    const track = Object.assign(new EventTarget(), { kind: "audio", enabled: true, stop: () => {} });
    client.prepareLocalTrack("microphone", track as unknown as MediaStreamTrack);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enable = vi.spyOn(initial.self, "enableAudio").mockImplementationOnce(() => pending);
    const target = { operationId: "enable", participantId: "participant", source: "microphone" as const, enabled: true };
    const first = client.setLocalPublicationTarget(target);
    await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce());
    const queued = client.setLocalPublicationTarget({ ...target, enabled: false });
    await client.clearPreparedLocalTrack("microphone");
    release();
    expect(await first).toMatchObject({ outcome: "retryable_failure" });
    expect(await queued).toMatchObject({ outcome: "terminal_failure", errorCode: "source_unavailable" });
    client.stop();
  });

  it("ignores a local enable that completes after a newer connection muted the source", async () => {
    const initial = connection();
    const replacement = connection();
    let complete = () => {};
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const enable = vi.spyOn(initial.self, "enableAudio").mockImplementationOnce(() => pending);
    let calls = 0;
    const client = new CloudflareRTKClient({ authToken: "initial", participantId: "participant", clientFactory: async () => (++calls === 1 ? initial : replacement) });
    const track = Object.assign(new EventTarget(), { kind: "audio", enabled: true, stop: () => {} });
    const oldStart = client.start({ getTracks: () => [track] } as unknown as MediaStream);
    await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce());
    await client.restart(access("replacement"));
    let publications: readonly MediaPublication[] = [];
    const unsubscribe = client.observeLocalPublications((current) => {
      publications = current;
    });
    expect(publications[0]?.enabled).toBe(false);
    track.enabled = false;
    complete();
    await oldStart;
    expect(publications[0]?.enabled).toBe(false);
    expect(track.enabled).toBe(false);
    unsubscribe();
    client.stop();
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
