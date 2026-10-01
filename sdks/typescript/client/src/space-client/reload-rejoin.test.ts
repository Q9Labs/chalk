import { describe, expect, it, vi } from "vitest";
import { parseAccessGrant } from "../access/grant";
import { readReloadRejoin, reloadRejoinLifetimeMs, reloadRejoinStorageKey, resumeReloadRejoin, writeReloadRejoin } from "./reload-rejoin";

const marker = { space: "design-lab", episodeId: "episode-1", participantId: "participant-1", participantGeneration: 1, arrivalHandle: "arrival-1", mediaProof: "proof", displayName: "Ada", microphone: false, camera: false };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function grant(episodeId = marker.episodeId, participantId = marker.participantId, participantGeneration = 1) {
  return parseAccessGrant({
    subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: episodeId, participant_id: participantId, participant_generation: participantGeneration },
    sync: { token: `${btoa("header")}.${btoa(JSON.stringify({ aud: "chalk-sync" }))}.signature`, expires_at: "2030-01-01T00:00:00Z" },
    media: { token: `${btoa("header")}.${btoa(JSON.stringify({ aud: "chalk-media" }))}.signature`, expires_at: "2030-01-01T00:00:00Z", provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:example.test" } },
  });
}
describe("reload recovery", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("preserves microphone=%s camera=%s and consumes the hint once", (microphone, camera) => {
    const tab = storage();
    writeReloadRejoin(tab, { ...marker, microphone, camera }, 1000);
    expect(readReloadRejoin(tab, marker.space, 1001)).toMatchObject({ ...marker, microphone, camera });
    expect(readReloadRejoin(tab, marker.space, 1001)).toBeNull();
  });
  it("expires after two minutes and refuses other Spaces or corrupt data", () => {
    const tab = storage();
    writeReloadRejoin(tab, marker, 1000);
    expect(readReloadRejoin(tab, marker.space, 1000 + reloadRejoinLifetimeMs)).toBeNull();
    writeReloadRejoin(tab, marker, 1000);
    expect(readReloadRejoin(tab, "other-space", 1001)).toBeNull();
    tab.setItem(reloadRejoinStorageKey, "{}");
    expect(readReloadRejoin(tab, marker.space, 1001)).toBeNull();
  });
  it("requires fresh authoritative access for the same Episode and Participant", async () => {
    const saved = { ...marker, version: 1 as const, expiresAt: 2000 };
    const refresh = vi.fn(async () => grant());
    await expect(resumeReloadRejoin(saved, refresh)).resolves.toBeDefined();
    expect(refresh).toHaveBeenCalledOnce();
    await expect(resumeReloadRejoin(saved, async () => grant("new-episode"))).rejects.toThrow("no longer belongs");
    await expect(resumeReloadRejoin(saved, async () => grant(marker.episodeId, "new-participant"))).rejects.toThrow("no longer belongs");
    await expect(resumeReloadRejoin(saved, async () => grant(marker.episodeId, marker.participantId, 2))).rejects.toThrow("no longer belongs");
  });
  it.each(["ended", "removed", "left"])("does not rejoin when the server rejects %s access", async (reason) => {
    await expect(
      resumeReloadRejoin({ ...marker, version: 1, expiresAt: 2000 }, async () => {
        throw new Error(reason);
      }),
    ).rejects.toThrow(reason);
  });
});
