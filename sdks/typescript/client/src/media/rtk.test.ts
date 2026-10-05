import { describe, expect, it, vi } from "vitest";
import type { ParticipantMediaAccess } from "../access/grant";
import { CloudflareRTKClient, type CloudflareRTKConnection } from "./rtk";

describe("RealtimeKit recovery ownership", () => {
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
