import { describe, expect, it } from "vitest";

import { FixtureMediaClient, projectFixtureRemoteTracks, recordFixtureRemoteTrack, reconcileFixtureRemoteTracks } from "../consumer/media-client.ts";

describe("fixture remote media ordering", () => {
  it("retains a track that arrives before its publication state", () => {
    const publication = screenPublication();
    const track = fakeTrack();
    const received = new Map();

    recordFixtureRemoteTrack(received, remoteTrack(publication, track));

    expect(track.stopCalls).toBe(0);
    expect(projectFixtureRemoteTracks([], received)).toEqual([]);

    reconcileFixtureRemoteTracks([publication], received);

    expect(track.stopCalls).toBe(0);
    expect(projectFixtureRemoteTracks([publication], received)).toEqual([received.get(remoteKey(publication))]);
  });

  it("keeps a track when publication state arrives before the track", () => {
    const publication = screenPublication();
    const received = new Map();

    reconcileFixtureRemoteTracks([publication], received);

    const track = fakeTrack();
    recordFixtureRemoteTrack(received, remoteTrack(publication, track));
    reconcileFixtureRemoteTracks([publication], received);

    expect(track.stopCalls).toBe(0);
    expect(projectFixtureRemoteTracks([publication], received)).toHaveLength(1);
  });

  it("stops and removes a track when publication state removes it", () => {
    const publication = screenPublication();
    const track = fakeTrack();
    const received = new Map([[remoteKey(publication), remoteTrack(publication, track)]]);

    reconcileFixtureRemoteTracks([publication], received);
    reconcileFixtureRemoteTracks([], received);

    expect(track.stopCalls).toBe(1);
    expect(track.readyState).toBe("ended");
    expect(received).toEqual(new Map());
    expect(projectFixtureRemoteTracks([], received)).toEqual([]);
  });
});

describe("fixture media provider boundary", () => {
  it("rejects RealtimeKit access at construction because the fixture speaks SFU signaling", () => {
    expect(
      () =>
        new FixtureMediaClient("ws://localhost/media", {
          access: { subject: { participantId: "alice" }, media: { token: "media-token", expiresAt: "2026-08-20T00:00:00Z", provider: "cloudflare_rtk", clientPayload: { providerSubject: "alice", token: "rtk-token" } } },
          credential: async () => "media-token",
          onFailure: () => undefined,
          onScreenEnded: () => undefined,
        }),
    ).toThrow("only supports Cloudflare SFU access");
  });

  it("rejects a RealtimeKit restart without changing the SFU fixture state", async () => {
    const client = new FixtureMediaClient("ws://localhost/media", {
      access: { subject: { participantId: "alice" }, media: { token: "media-token", expiresAt: "2026-08-20T00:00:00Z", provider: "cloudflare_sfu", clientPayload: { connectionId: "connection-1", stunServer: "stun:test" } } },
      credential: async () => "media-token",
      onFailure: () => undefined,
      onScreenEnded: () => undefined,
    });

    await expect(client.restart({ token: "media-token", expiresAt: "2026-08-20T00:00:00Z", provider: "cloudflare_rtk", clientPayload: { providerSubject: "alice", token: "rtk-token" } })).rejects.toThrow("only supports Cloudflare SFU access");
  });
});

function screenPublication() {
  return { participantId: "alice", source: "screen", enabled: true, publicationId: "alice-screen" };
}

function remoteKey(publication) {
  return `${publication.participantId}:${publication.source}`;
}

function remoteTrack(publication, track) {
  return { ...publication, track };
}

function fakeTrack() {
  return new FakeTrack();
}

class FakeTrack {
  readyState = "live";
  stopCalls = 0;

  stop() {
    this.stopCalls += 1;
    this.readyState = "ended";
  }
}
