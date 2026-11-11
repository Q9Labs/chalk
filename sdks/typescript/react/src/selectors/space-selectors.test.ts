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
