import type { Participant } from "@q9labsai/chalk-client";
import { expect, it } from "vitest";
import { toVideoParticipants } from "./space-selectors";

const guest = (presence: Partial<Participant["presence"]>): Participant => ({
  participantId: "nora",
  displayName: "Nora",
  role: "guest",
  eligibleRoles: ["guest"],
  capabilities: [],
  handRaised: false,
  media: { microphone: "active", camera: "inactive", screenShare: "inactive" },
  presence: { state: "connected", speaking: false, activeSpeaker: false, ...presence },
});

const off = (source: "microphone" | "camera" | "screen") => ({ source, state: "disabled" as const, track: null });
const localMedia = { microphone: off("microphone"), camera: off("camera"), screen: off("screen") };

const tileOf = (presence: Partial<Participant["presence"]>) => toVideoParticipants([guest(presence)], [], "you", "Alex", localMedia).find((tile) => tile.id === "nora");

it("shows bars for a weak or very poor guest and nothing for good or unknown", () => {
  expect(tileOf({ connectionQuality: "weak" })?.connectionQuality).toBe(2);
  expect(tileOf({ connectionQuality: "poor" })?.connectionQuality).toBe(1);
  expect(tileOf({ connectionQuality: "good" })?.connectionQuality).toBe(4);
  expect(tileOf({})?.connectionQuality).toBeUndefined();
});

it("marks a guest whose presence dropped as reconnecting", () => {
  expect(tileOf({ state: "disconnected" })?.isReconnecting).toBe(true);
  expect(tileOf({})?.isReconnecting).toBeUndefined();
});

it("keeps your own picture and microphone on while Sync recovers a source it had confirmed", () => {
  const track = (kind: string, enabled = true) => ({ kind, enabled, readyState: "live" }) as MediaStreamTrack;
  const own = (camera: ReturnType<typeof off> | { source: "camera"; state: "requesting"; track: MediaStreamTrack }, microphone: ReturnType<typeof off> | { source: "microphone"; state: "requesting"; track: MediaStreamTrack }) =>
    toVideoParticipants([], [], "you", "Alex", { ...localMedia, camera, microphone }).find((tile) => tile.id === "you");
  const recovering = own({ source: "camera", state: "requesting", track: track("video") }, { source: "microphone", state: "requesting", track: track("audio") });
  expect(recovering?.isVideoEnabled).toBe(true);
  expect(recovering?.isMuted).toBe(false);
  const stopped = own({ source: "camera", state: "requesting", track: track("video", false) }, off("microphone"));
  expect(stopped?.isVideoEnabled).toBe(false);
  expect(stopped?.isMuted).toBe(true);
});
