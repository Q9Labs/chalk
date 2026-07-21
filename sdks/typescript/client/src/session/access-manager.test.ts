import { describe, expect, it, vi } from "vitest";

import { ChalkSessionAccessManager } from "./access-manager";
import type { ParticipantAccess } from "./access";

const SUBJECT = { tenantId: "tenant-1", roomId: "room-1", sessionId: "session-1", participantSessionId: "participant-1", participantGeneration: 1 } as const;

describe("ChalkSessionAccessManager", () => {
  it("refreshes at sixty seconds and proves the current media connection with its signed token", async () => {
    let now = Date.parse("2026-07-21T12:00:00.000Z");
    const first = access(now + 61_000, "connection-1", "first");
    const second = access(now + 300_000, "connection-1", "second");
    const provider = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = new ChalkSessionAccessManager(provider, () => now);

    await expect(manager.initialize()).resolves.toEqual(first);
    expect(manager.millisecondsUntilRefresh()).toBe(1_000);
    now += 1_000;
    await expect(manager.getMediaToken()).resolves.toBe(second.media.token);
    expect(provider.mock.calls[1]?.[0]).toEqual({
      reason: "scheduled_refresh",
      replaceMediaConnection: false,
      currentMediaToken: first.media.token,
      expectedParticipantGeneration: 1,
    });
  });

  it("rejects subject changes and ordinary media-connection replacement", async () => {
    const now = Date.parse("2026-07-21T12:00:00.000Z");
    const initial = access(now + 300_000, "connection-1", "initial");
    const provider = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(access(now + 300_000, "connection-2", "replacement"));
    const manager = new ChalkSessionAccessManager(provider, () => now);

    await manager.initialize();
    await expect(manager.refresh("scheduled_refresh", false)).rejects.toThrow("unexpectedly replaced");
  });

  it("serializes refreshes but follows an ordinary in-flight refresh with an explicit replacement", async () => {
    const now = Date.parse("2026-07-21T12:00:00.000Z");
    const initial = access(now + 300_000, "connection-1", "initial");
    let release!: (value: ParticipantAccess) => void;
    const ordinary = new Promise<ParticipantAccess>((resolve) => (release = resolve));
    const provider = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(ordinary)
      .mockResolvedValueOnce(access(now + 300_000, "connection-2", "replacement"));
    const manager = new ChalkSessionAccessManager(provider, () => now);
    await manager.initialize();

    const scheduled = manager.refresh("scheduled_refresh", false);
    const replacement = manager.refresh("media_recovery", true);
    release(access(now + 300_000, "connection-1", "ordinary"));

    await expect(scheduled).resolves.toMatchObject({ media: { clientPayload: { connectionId: "connection-1" } } });
    await expect(replacement).resolves.toMatchObject({ media: { clientPayload: { connectionId: "connection-2" } } });
    expect(provider.mock.calls[2]?.[0]).toMatchObject({ reason: "media_recovery", replaceMediaConnection: true });
  });

  it("invalidates a pending commit on clear so it cannot overwrite a newer join", async () => {
    const now = Date.parse("2026-07-21T12:00:00.000Z");
    const stale = deferred<ParticipantAccess>();
    const fresh = access(now + 300_000, "connection-fresh", "fresh");
    const provider = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValueOnce(fresh);
    const manager = new ChalkSessionAccessManager(provider, () => now);

    const first = manager.initialize();
    const invalidated = expect(first).rejects.toThrow("invalidated");
    manager.clear();
    await expect(manager.initialize()).resolves.toEqual(fresh);
    stale.resolve(access(now + 300_000, "connection-stale", "stale"));

    await invalidated;
    expect(manager.current).toEqual(fresh);
  });
});

function access(expiresAt: number, connectionId: string, tokenSuffix: string): ParticipantAccess {
  return {
    subject: SUBJECT,
    sync: { token: credential("chalk-sync", tokenSuffix), expiresAt: new Date(expiresAt).toISOString() },
    media: {
      token: credential("chalk-media", tokenSuffix),
      expiresAt: new Date(expiresAt).toISOString(),
      provider: "cloudflare_sfu",
      clientPayload: { connectionId, stunServer: "stun:stun.cloudflare.com:3478" },
    },
  };
}

function credential(audience: "chalk-sync" | "chalk-media", suffix: string) {
  const encode = (json: string) => btoa(json).replace(/[+/=]/g, (character) => ({ "+": "-", "/": "_", "=": "" })[character] ?? "");
  return `${encode('{"alg":"EdDSA"}')}.${encode(`{"aud":"${audience}"}`)}.${suffix}` as ParticipantAccess["sync"]["token"] & ParticipantAccess["media"]["token"];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
}
