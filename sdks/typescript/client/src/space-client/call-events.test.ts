import { describe, expect, it } from "vitest";
import { callEvents } from "./call-events";
import { SpaceStore } from "./store";
import type { Capability, Participant, SpaceSnapshot } from "./types";

const empty = new SpaceStore().getSnapshot();

function person(participantId: string, overrides: Partial<Participant> = {}): Participant {
  return {
    participantId,
    displayName: `Person ${participantId}`,
    role: "guest",
    eligibleRoles: [],
    capabilities: [],
    handRaised: false,
    media: { microphone: "unknown", camera: "unknown", screenShare: "inactive" },
    presence: { state: "connected", speaking: false, activeSpeaker: false },
    ...overrides,
  };
}

function live(roster: readonly Participant[], patch: { readonly host?: boolean; readonly micOn?: boolean } = {}): SpaceSnapshot {
  return {
    ...empty,
    connection: { ...empty.connection, status: "live" },
    self: { ...empty.self, participantId: "me", can: (capability: Capability) => patch.host === true && capability === "endEpisode" },
    participants: { ...empty.participants, roster },
    media: { ...empty.media, local: { ...empty.media.local, microphone: { ...empty.media.local.microphone, state: patch.micOn === false ? "disabled" : "enabled" } } },
  };
}

describe("callEvents", () => {
  it("reports other people joining and leaving, never the local participant", () => {
    const before = live([person("me"), person("a")]);
    const after = live([person("me"), person("b")]);
    expect(callEvents(before, after).map((event) => event.kind)).toEqual(["joined", "left"]);
    expect(callEvents(live([]), live([person("me")]))).toEqual([]);
  });

  it("says nothing when either snapshot is not live", () => {
    const before = { ...live([person("a")]), connection: { ...empty.connection, status: "joining" as const } };
    expect(callEvents(before, live([person("a"), person("b")]))).toEqual([]);
  });

  it("reports a raised hand and a stopped share", () => {
    const before = live([person("a", { media: { microphone: "unknown", camera: "unknown", screenShare: "active" } })]);
    const after = live([person("a", { handRaised: true })]);
    expect(callEvents(before, after).map((event) => event.kind)).toEqual(["handRaised", "shareStopped"]);
  });

  it("folds the departed host into hostChanged instead of a plain leave", () => {
    const host = person("h", { capabilities: ["endEpisode"] });
    const events = callEvents(live([host]), live([], { host: true }));
    expect(events).toEqual([{ kind: "hostChanged", previousHost: host }]);
  });

  it("calls a microphone that went off a host mute unless the person did it", () => {
    const muter = person("m", { capabilities: ["muteOthers"] });
    const before = live([muter]);
    const after = live([muter], { micOn: false });
    expect(callEvents(before, after)).toEqual([{ kind: "mutedByHost", by: muter }]);
    expect(callEvents(before, after, true)).toEqual([]);
  });
});
