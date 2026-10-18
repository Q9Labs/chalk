import type { Participant, SpaceSnapshot } from "@q9labsai/chalk-client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createSnapshot } from "../../test-support";
import { callEventToasts, mediaFailureToast } from "./call-events";

function live(): SpaceSnapshot {
  const base = createSnapshot();
  return { ...base, connection: { ...base.connection, status: "live" }, self: { ...base.self, participantId: "self", role: "guest" } };
}
const host: Participant = { participantId: "host", displayName: "Nora", role: "host", eligibleRoles: ["host"], capabilities: [], handRaised: false, media: { microphone: "active", camera: "active", screenShare: "inactive" }, presence: { state: "connected", speaking: false, activeSpeaker: false } };
it("announces a departed host only when you become host, without a second leave notice", () => {
  const base = live();
  const before = { ...base, participants: { ...base.participants, roster: [host] } };
  const events = callEventToasts(before, { ...base, self: { ...base.self, role: "host" } });
  expect(events).toHaveLength(1);
  expect(renderToStaticMarkup(<>{events[0]?.message}</>)).toContain("Nora</b> left. You’re now the host.");
  expect(callEventToasts(before, { ...before, participants: { ...before.participants, roster: [{ ...host, role: "guest" }] } })).toHaveLength(0);
});
it("does not announce manual device selection, but explains an unplugged device fallback", () => {
  const base = live();
  const first = { deviceId: "first", label: "AirPods Pro" };
  const second = { deviceId: "second", label: "MacBook Air Microphone" };
  const before = { ...base, media: { ...base.media, selection: { ...base.media.selection, microphone: first.deviceId }, devices: { ...base.media.devices, microphones: [first, second] } } };
  const selected = { ...before, media: { ...before.media, selection: { ...before.media.selection, microphone: second.deviceId } } };
  expect(callEventToasts(before, selected)).toHaveLength(0);
  const unplugged = { ...selected, media: { ...selected.media, devices: { ...selected.media.devices, microphones: [second] } } };
  const events = callEventToasts(before, unplugged);
  expect(events).toHaveLength(1);
  expect(renderToStaticMarkup(<>{events[0]?.message}</>)).toContain("AirPods Pro disconnected. Switched to <b");
});

it("explains a missing camera with the canonical device recovery copy", () => {
  const toast = mediaFailureToast({ code: "media.device_not_found", recoverable: true, message: "Missing input" }, "camera");
  const text = renderToStaticMarkup(<>{toast?.message}</>);
  expect(text).toContain("No camera found.");
  expect(text).toContain("Plug one in, or check that your Mac can see it in System Settings.");
});
