import { expect, it, vi } from "vitest";
import { otherDevices } from "./same-identity";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";
import { stream, track } from "./capture.test.helpers";
import type { V1Presence } from "../sync/v1-types";

const presence = (participantId: string, identityId?: string, state: V1Presence["state"] = "connected"): V1Presence => ({ participantId, identityId, state, speaking: false, activeSpeaker: false });
it("matches a verified person identity only across live distinct seats", () => {
  const seats = [presence("desktop", "person"), presence("phone", "person"), presence("gone", "person", "disconnected"), presence("someone", "other"), presence("anonymous")];
  expect(otherDevices(seats, "desktop").map((item) => item.participantId)).toEqual(["phone"]);
  expect(otherDevices(seats, "anonymous")).toEqual([]);
  expect(otherDevices(seats, null)).toEqual([]);
});
it.each([true, false])("joining with another device microphone %s preserves that device and starts the new mic safely", async (enabled) => {
  const platform = createCoreTestPlatform();
  const mic = track("audio");
  const start = vi.fn(async (_stream: MediaStream) => undefined);
  platform.emitSync({
    ...platform.sync.getSnapshot(),
    presence: { projectionId: "presence", sequence: 0, items: [presence("participant-1", "person"), presence("desktop", "person")] },
    media: { projectionId: "media", sequence: 0, items: [{ participantId: "desktop", source: "microphone", enabled, publicationId: enabled ? "publication" : null }] },
  });
  const client = createSpaceClientForPlatform(
    { space: "space-1", getAccess: async () => opaqueAccessGrant("test") },
    { ...platform, dependencies: { ...platform.dependencies, mediaDevices: { getUserMedia: async () => stream([mic]) }, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), start }) } },
  );
  try {
    await client.join({ microphone: true, camera: false });
    expect(start.mock.calls[0]?.[0].getTracks().filter((track) => track.kind === "audio")).toHaveLength(enabled ? 0 : 1);
    expect(client.getSnapshot().media.microphoneMutedByOtherDevice).toBe(enabled);
    expect(platform.sync.getSnapshot().media?.items[0]?.enabled).toBe(enabled);
  } finally {
    client.dispose();
  }
});
