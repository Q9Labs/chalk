import type { Capability, Participant, SpaceSnapshot } from "@q9labsai/chalk-client";
import { describe, expect, it } from "vitest";
import { callNotices } from "./notices";

const HOST: readonly Capability[] = ["endEpisode", "muteOthers"];

function person(participantId: string, displayName: string, capabilities: readonly Capability[] = [], screenShare: "active" | "inactive" = "inactive"): Participant {
  return {
    participantId,
    displayName,
    role: capabilities.length ? "host" : "guest",
    eligibleRoles: [],
    capabilities,
    handRaised: false,
    media: { microphone: "inactive", camera: "inactive", screenShare },
    presence: { state: "connected", speaking: false, activeSpeaker: false },
  };
}

type Shape = {
  readonly status?: SpaceSnapshot["connection"]["status"];
  readonly roster?: readonly Participant[];
  readonly selfCapabilities?: readonly Capability[];
  readonly microphone?: "enabled" | "disabled";
  readonly requests?: SpaceSnapshot["media"]["incomingRequests"];
  readonly recording?: "recording" | "stopped";
};

function snapshot({ status = "live", roster = [], selfCapabilities = [], microphone = "disabled", requests = [], recording }: Shape): SpaceSnapshot {
  const local = (state: "enabled" | "disabled") => ({ source: "microphone" as const, state, track: null });
  return {
    connection: { status, episode: null, lastError: null },
    self: { participantId: "me", displayName: "Hasan", role: null, capabilities: selfCapabilities, handRaised: false, can: (capability) => selfCapabilities.includes(capability) },
    participants: { roster: [person("me", "Hasan", selfCapabilities), ...roster], admissionQueue: [] },
    media: {
      devices: { microphones: [], cameras: [], speakers: [] },
      selection: { microphone: null, camera: null, speaker: null },
      local: { microphone: local(microphone), camera: { ...local("disabled"), source: "camera" }, screen: { ...local("disabled"), source: "screen" } },
      remote: [],
      screenShare: { ...local("disabled"), source: "screen" },
      incomingRequests: requests,
    },
    chat: { status: "ready", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    recording: { current: recording ? { recordingId: "r1", status: recording, failureCode: null } : null },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, presenting: false, error: null }, access: { canDraw: false, policy: null, permissions: [] } },
    offline: { pending: [], decisionNeeded: false, policy: "ask" },
  };
}

const nora = person("nora", "Nora Lindqvist", HOST);
const sam = person("sam", "Sam Okafor");

describe("callNotices", () => {
  it("says nothing while the roster arrives on join or empties on leave", () => {
    expect(callNotices(snapshot({ status: "joining" }), snapshot({ roster: [nora, sam] }), false)).toEqual([]);
    expect(callNotices(snapshot({ roster: [nora, sam] }), snapshot({ status: "left" }), false)).toEqual([]);
  });

  it("names people who join and leave, but never you", () => {
    expect(callNotices(snapshot({ roster: [nora] }), snapshot({ roster: [nora, sam] }), false)).toEqual([{ kind: "joined", name: "Sam Okafor" }]);
    expect(callNotices(snapshot({ roster: [nora, sam] }), snapshot({ roster: [nora] }), false)).toEqual([{ kind: "left", name: "Sam Okafor" }]);
  });

  it("tells you the host left and you're the host now, instead of a plain leave", () => {
    const notices = callNotices(snapshot({ roster: [nora, sam] }), snapshot({ roster: [sam], selfCapabilities: HOST }), false);
    expect(notices).toEqual([{ kind: "newHost", previousHost: "Nora" }]);
  });

  it("reports a host mute only when you didn't mute yourself", () => {
    const before = snapshot({ roster: [nora, sam], microphone: "enabled" });
    const after = snapshot({ roster: [nora, sam], microphone: "disabled" });
    expect(callNotices(before, after, false)).toEqual([{ kind: "mutedByHost", by: "Nora" }]);
    expect(callNotices(before, after, true)).toEqual([]);
  });

  it("reports each new request to unmute once", () => {
    const request = { requestId: "q1", kind: "unmute" as const, actorParticipantId: "nora", actorDisplayName: "Nora Lindqvist", expiresAt: "2026-10-18T12:00:00Z" };
    expect(callNotices(snapshot({ roster: [nora] }), snapshot({ roster: [nora], requests: [request] }), false)).toEqual([{ kind: "mediaRequest", request }]);
    expect(callNotices(snapshot({ roster: [nora], requests: [request] }), snapshot({ roster: [nora], requests: [request] }), false)).toEqual([]);
  });

  it("reports when someone else stops sharing", () => {
    const sharing = person("sam", "Sam Okafor", [], "active");
    expect(callNotices(snapshot({ roster: [sharing] }), snapshot({ roster: [sam] }), false)).toEqual([{ kind: "shareStopped", name: "Sam" }]);
  });

  it("reports recording starting and stopping", () => {
    expect(callNotices(snapshot({}), snapshot({ recording: "recording" }), false)).toEqual([{ kind: "recordingStarted" }]);
    expect(callNotices(snapshot({ recording: "recording" }), snapshot({ recording: "stopped" }), false)).toEqual([{ kind: "recordingStopped" }]);
  });
});
