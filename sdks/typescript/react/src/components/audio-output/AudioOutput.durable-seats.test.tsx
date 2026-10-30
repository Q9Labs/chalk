// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { ConnectionLifecycleCapability } from "../../../../client/src/connection";
import { makeParticipantsController } from "../../../../client/src/space-client/participants-controller";
import { SpaceStore } from "../../../../client/src/space-client/store";
import { createCoreTestPlatform, opaqueAccessGrant } from "../../../../client/src/space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../../../../client/src/space-client/space-client";
import { control } from "../../../../client/src/space-client/terminal.test.helpers";
import { stream, track as captureTrack } from "../../../../client/src/space-client/capture.test.helpers";
import { mediaTrack } from "../../../../client/tests/helpers/media-convergence";
import { useMedia, useParticipants, useSelf } from "../../bindings/hooks";
import { AudioOutput } from "./AudioOutput";

vi.mock("../../bindings/hooks", () => ({ useSelf: vi.fn(), useMedia: vi.fn(), useParticipants: vi.fn() }));
vi.mock("../participants-panel/participant-volume-context", () => ({ useParticipantVolumeContext: () => null }));
afterEach(() => vi.restoreAllMocks());
const person = control.participants[0]!;
const presence = (participantId: string, identityId = "00000000-0000-4000-8000-000000000001") => ({ participantId, identityId, state: "connected" as const, speaking: false, activeSpeaker: false });
function seed(known = true, audioSource = "audioTrack") {
  const platform = createCoreTestPlatform();
  platform.emitSync({
    ...platform.sync.getSnapshot(),
    control: {
      ...control,
      participants: [
        { ...person, participantId: "participant-1" },
        { ...person, participantId: "own-phone" },
      ],
    },
    presence: { projectionId: "presence", sequence: 0, items: known ? [presence("participant-1"), presence("own-phone")] : [presence("participant-1")] },
    media: { projectionId: "media", sequence: 0, items: [{ participantId: "own-phone", source: audioSource === "audioTrack" ? "microphone" : "screen", enabled: true, publicationId: "phone-audio" }] },
  });
  return platform;
}
// New-server transport fixture: every admitted seat has a verified association,
// even when that seat has no socket. Other cases retain the older-server fixture.
function durableSeats(platform: ReturnType<typeof seed>) {
  const emit = platform.emitSync;
  const devices = new Map([
    ["participant-1", presence("participant-1")],
    ["own-phone", presence("own-phone")],
  ]);
  platform.emitSync = (snapshot) => {
    if (snapshot.presence && snapshot.control)
      snapshot = {
        ...snapshot,
        presence: {
          ...snapshot.presence,
          items: snapshot.control.participants.map((seat) => {
            const device = devices.get(seat.participantId);
            if (!device) throw new Error("fixture requires a verified seat");
            return { ...device, state: snapshot.presence?.items.some((item) => item.participantId === seat.participantId) ? "connected" : "disconnected", admissionRevision: seat.admissionRevision };
          }),
        },
      };
    emit(snapshot);
  };
  platform.emitSync(platform.sync.getSnapshot());
  return platform;
}
function clientFor(platform: ReturnType<typeof seed>) {
  return createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("review") }, platform);
}
async function rendered(client: ReturnType<typeof clientFor>, audioSource: string) {
  vi.mocked(useSelf).mockImplementation(() => client.getSnapshot().self);
  vi.mocked(useParticipants).mockImplementation(() => client.getSnapshot().participants);
  vi.mocked(useMedia).mockImplementation(() => client.getSnapshot().media);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const root = createRoot(document.createElement("div"));
  const audio = Object.assign(mediaTrack(), { id: "phone-audio" });
  const render = () => root.render(<AudioOutput participants={[{ id: "own-phone", [audioSource]: audio }]} />);
  await act(async () => render());
  return { play, render: async () => act(async () => render()), close: async () => act(async () => root.unmount()) };
}

it.each(["audioTrack", "screenShareAudioTrack"])("a pending local seat suppresses sibling %s before its own roster entry arrives", async (source) => {
  const platform = seed(false, source);
  const snapshot = platform.sync.getSnapshot();
  platform.emitSync({
    ...snapshot,
    participantIdentityId: presence("own-phone").identityId,
    control: { ...control, participants: [{ ...person, participantId: "own-phone" }] },
    presence: { projectionId: "pending", sequence: 0, items: [{ ...presence("own-phone"), state: "disconnected" }] },
  });
  const client = clientFor(platform);
  let view: Awaited<ReturnType<typeof rendered>> | undefined;
  try {
    await client.join({ microphone: false, camera: false });
    expect(client.getSnapshot().participants.roster.some((seat) => seat.participantId === "participant-1")).toBe(false);
    view = await rendered(client, source);
    expect(view.play).not.toHaveBeenCalled();
  } finally {
    await view?.close();
    client.dispose();
  }
});

it.each(["audioTrack", "screenShareAudioTrack"])("REQUIREMENT: late joining during sibling presence gap suppresses %s", async (source) => {
  const platform = durableSeats(seed(false, source));
  const client = clientFor(platform);
  let view: Awaited<ReturnType<typeof rendered>> | undefined;
  try {
    await client.join({ microphone: false, camera: false });
    expect(client.getSnapshot().participants.roster.find((p) => p.participantId === "own-phone")?.media[source === "audioTrack" ? "microphone" : "screenShare"]).toBe("active");
    view = await rendered(client, source);
    expect(view.play, "a fresh client must suppress its same-person sibling even if its Sync socket is absent").not.toHaveBeenCalled();
  } finally {
    await view?.close();
    client.dispose();
  }
});

it.each(["audioTrack", "screenShareAudioTrack"])("REQUIREMENT: page reload during sibling presence gap suppresses %s", async (source) => {
  const platform = durableSeats(seed(true, source));
  const first = clientFor(platform);
  await first.join({ microphone: false, camera: false });
  expect(first.getSnapshot().participants.roster.find((p) => p.participantId === "own-phone")?.identityId).toBe(presence("own-phone").identityId);
  platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "gap", sequence: 0, items: [presence("participant-1")] } });
  first.dispose();
  const reloaded = clientFor(platform);
  let view: Awaited<ReturnType<typeof rendered>> | undefined;
  try {
    await reloaded.join({ microphone: false, camera: false });
    view = await rendered(reloaded, source);
    expect(view.play, "recreating the client must not re-enable self playback").not.toHaveBeenCalled();
  } finally {
    await view?.close();
    reloaded.dispose();
  }
});

it.each(["late join", "page reload"])("REQUIREMENT: %s starts microphone off while an absent sibling keeps sending", async (scenario) => {
  const platform = durableSeats(seed(scenario === "page reload"));
  if (scenario === "page reload") {
    const first = clientFor(platform);
    await first.join({ microphone: false, camera: false });
    platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "gap", sequence: 0, items: [presence("participant-1")] } });
    first.dispose();
  }
  const microphone = captureTrack("audio");
  let published: MediaStream | undefined;
  const client = clientFor({
    ...platform,
    dependencies: {
      ...platform.dependencies,
      mediaDevices: { getUserMedia: async () => stream([microphone]) },
      createMediaClient: (input) => ({
        ...platform.dependencies.createMediaClient(input),
        start: async (_stream, beforePublish) => {
          published = await beforePublish?.();
        },
      }),
    },
  });
  try {
    await client.join({ microphone: true, camera: false });
    expect(
      published?.getTracks().filter((track) => track.kind === "audio"),
      "an active same-person sibling should prevent a second live microphone",
    ).toHaveLength(0);
    expect(client.getSnapshot().media.microphoneMutedByOtherDevice).toBe(true);
  } finally {
    client.dispose();
  }
});

it.each(["audioTrack", "screenShareAudioTrack"])("known identities survive either device reconnecting, both presence gaps, and replica recovery for %s", async (source) => {
  const platform = seed(true, source);
  const client = clientFor(platform);
  let view: Awaited<ReturnType<typeof rendered>> | undefined;
  try {
    await client.join({ microphone: false, camera: false });
    view = await rendered(client, source);
    const initial = platform.sync.getSnapshot();
    for (const items of [[presence("participant-1")], [], [presence("own-phone")], [presence("own-phone"), presence("participant-1")]]) {
      platform.emitSync({ ...initial, presence: { projectionId: "replacement-" + JSON.stringify(items), sequence: 0, items } });
      await view.render();
      expect(view.play).not.toHaveBeenCalled();
    }
    platform.emitSync({ ...initial, control: null, media: null, presence: null });
    await view.render();
    expect(view.play).not.toHaveBeenCalled();
    platform.emitSync({ ...initial, presence: { projectionId: "recovered", sequence: 0, items: [presence("participant-1")] } });
    await view.render();
    expect(view.play).not.toHaveBeenCalled();
    // Match V1Client.#disconnected: it clears live projections and reconnects
    // using the same admitted subject while media may continue independently.
    platform.emitSync({ ...initial, connection: { phase: "connecting" }, media: null, presence: null });
    await view.render();
    expect(view.play).not.toHaveBeenCalled();
    platform.emitSync({ ...initial, connection: { phase: "live" }, presence: { projectionId: "local-reconnect", sequence: 0, items: [presence("participant-1")] } });
    await view.render();
    expect(view.play).not.toHaveBeenCalled();
  } finally {
    await view?.close();
    client.dispose();
  }
});

it.each(["audioTrack", "screenShareAudioTrack"])("a cold gap starts playing %s and sibling Sync reconnect finally stops it", async (source) => {
  const platform = seed(false, source);
  const client = clientFor(platform);
  let view: Awaited<ReturnType<typeof rendered>> | undefined;
  try {
    await client.join({ microphone: false, camera: false });
    view = await rendered(client, source);
    expect(view.play).toHaveBeenCalledTimes(1);
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();
    platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "sibling-reconnected", sequence: 0, items: [presence("participant-1"), presence("own-phone")] } });
    await view.render();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(view.play).toHaveBeenCalledTimes(1);
  } finally {
    await view?.close();
    client.dispose();
  }
});

it("a reused seat with a fresh admission and a different authoritative identity stays audible through its next presence gap", async () => {
  const platform = seed();
  const client = clientFor(platform);
  let view: Awaited<ReturnType<typeof rendered>> | undefined;
  try {
    await client.join({ microphone: false, camera: false });
    const initial = platform.sync.getSnapshot();
    platform.emitSync({ ...initial, control: { ...initial.control!, participants: initial.control!.participants.filter((p) => p.participantId !== "own-phone") } });
    const rejoined = { ...initial.control!, participants: initial.control!.participants.map((p) => (p.participantId === "own-phone" ? { ...p, admissionRevision: p.admissionRevision + 1 } : p)) };
    platform.emitSync({ ...initial, control: rejoined });
    expect(client.getSnapshot().participants.roster.find((p) => p.participantId === "own-phone")?.identityId).toBeUndefined();
    platform.emitSync({ ...initial, control: rejoined, presence: { projectionId: "new-generation", sequence: 0, items: [presence("participant-1"), presence("own-phone", "00000000-0000-4000-8000-000000000002")] } });
    view = await rendered(client, "audioTrack");
    expect(view.play).toHaveBeenCalledTimes(1);
    platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "next-gap", sequence: 0, items: [presence("participant-1")] } });
    await view.render();
    expect(client.getSnapshot().participants.roster.find((p) => p.participantId === "own-phone")?.identityId).toBe("00000000-0000-4000-8000-000000000002");
    expect(view.play).toHaveBeenCalledTimes(1);
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  } finally {
    await view?.close();
    client.dispose();
  }
});

it.each(["leave", "generation", "end", "identity correction", "older server"])("association cleanup: %s", async (scenario) => {
  const platform = seed();
  const client = clientFor(platform);
  try {
    await client.join({ microphone: false, camera: false });
    const initial = platform.sync.getSnapshot();
    const roster = () => client.getSnapshot().participants.roster;
    if (scenario === "leave") {
      platform.emitSync({ ...initial, control: { ...initial.control!, participants: initial.control!.participants.filter((p) => p.participantId !== "own-phone") } });
      expect(roster().some((p) => p.participantId === "own-phone")).toBe(false);
      platform.emitSync({ ...initial, control: { ...initial.control!, participants: initial.control!.participants.map((p) => (p.participantId === "own-phone" ? { ...p, admissionRevision: p.admissionRevision + 1 } : p)) } });
      expect(roster().find((p) => p.participantId === "own-phone")?.identityId).toBeUndefined();
    } else if (scenario === "generation") {
      platform.emitSync({ ...initial, control: { ...initial.control!, participants: initial.control!.participants.map((p) => (p.participantId === "own-phone" ? { ...p, admissionRevision: p.admissionRevision + 1 } : p)) } });
      expect(roster().find((p) => p.participantId === "own-phone")?.identityId).toBeUndefined();
    } else if (scenario === "end") {
      platform.emitSync({ ...initial, control: { ...initial.control!, status: "ended" } });
      expect(roster()).toEqual([]);
    } else if (scenario === "identity correction") {
      platform.emitSync({ ...initial, presence: { projectionId: "corrected", sequence: 0, items: [presence("participant-1"), presence("own-phone", "00000000-0000-4000-8000-000000000002")] } });
      expect(roster().find((p) => p.participantId === "own-phone")?.identityId).toBe("00000000-0000-4000-8000-000000000002");
    } else {
      client.dispose();
      platform.emitSync({ ...initial, presence: { projectionId: "legacy", sequence: 0, items: ["participant-1", "own-phone"].map((participantId) => ({ participantId, state: "connected" as const, speaking: false, activeSpeaker: false })) } });
      const legacy = clientFor(platform);
      try {
        await legacy.join({ microphone: false, camera: false });
        expect(legacy.getSnapshot().participants.roster.every((p) => p.identityId === undefined)).toBe(true);
        const view = await rendered(legacy, "audioTrack");
        try {
          expect(view.play).toHaveBeenCalledTimes(1);
        } finally {
          await view.close();
        }
      } finally {
        legacy.dispose();
      }
    }
  } finally {
    client.dispose();
  }
});

it.each(["tenantId", "spaceId", "episodeId", "participantId", "participantGeneration"] as const)("cache does not carry associations across changed %s", async (field) => {
  const platform = seed();
  const store = new SpaceStore();
  const subject = { tenantId: "tenant-1", spaceId: "space-1", episodeId: "episode-1", participantId: "participant-1", participantGeneration: 1 };
  const connection = {
    getSnapshot: () => ({ state: "joined", subject }),
    subscribePorts: (listener: (ports: unknown) => void) => {
      listener({ sync: platform.sync, media: { ...platform.media, subscribe: () => () => {} } });
      return () => {};
    },
  } as unknown as ConnectionLifecycleCapability;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* makeParticipantsController(connection, store);
        expect(store.getSnapshot().participants.roster.find((p) => p.participantId === "own-phone")?.identityId).toBe(presence("own-phone").identityId);
        if (field === "participantGeneration") subject[field] = 2;
        else subject[field] = "new-value";
        platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "new-scope", sequence: 0, items: [] } });
        expect(store.getSnapshot().participants.roster.every((p) => p.identityId === undefined)).toBe(true);
      }),
    ),
  );
});

it("a fresh legacy-server join publishes the requested microphone and plays unrelated audio", async () => {
  const platform = seed();
  platform.emitSync({ ...platform.sync.getSnapshot(), presence: { projectionId: "legacy", sequence: 0, items: ["participant-1", "own-phone"].map((participantId) => ({ participantId, state: "connected" as const, speaking: false, activeSpeaker: false })) } });
  const microphone = captureTrack("audio");
  let published: MediaStream | undefined;
  const client = clientFor({
    ...platform,
    dependencies: {
      ...platform.dependencies,
      mediaDevices: { getUserMedia: async () => stream([microphone]) },
      createMediaClient: (input) => ({
        ...platform.dependencies.createMediaClient(input),
        start: async (_stream, beforePublish) => {
          published = await beforePublish?.();
        },
      }),
    },
  });
  try {
    await client.join({ microphone: true, camera: false });
    expect(published?.getTracks().filter((track) => track.kind === "audio")).toHaveLength(1);
    expect(client.getSnapshot().media.microphoneMutedByOtherDevice).toBe(false);
    const view = await rendered(client, "audioTrack");
    try {
      expect(view.play).toHaveBeenCalledTimes(1);
    } finally {
      await view.close();
    }
  } finally {
    client.dispose();
  }
});
