import type { Participant, SpaceSnapshot } from "@q9labsai/chalk-client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createSnapshot } from "../../test-support";
import { ChalkToast } from "../chalk-ui/ChalkToast";
import { callEventToasts, mediaFailureToast } from "./call-events";

function live(): SpaceSnapshot {
  const base = createSnapshot();
  return { ...base, connection: { ...base.connection, status: "live" }, self: { ...base.self, participantId: "self", role: "guest" } };
}
const host: Participant = {
  participantId: "host",
  displayName: "Nora",
  role: "owner",
  eligibleRoles: ["owner"],
  capabilities: ["endEpisode"],
  handRaised: false,
  media: { microphone: "active", camera: "active", screenShare: "inactive" },
  presence: { state: "connected", speaking: false, activeSpeaker: false },
};
it.each(["owner", "custom-moderator"])("announces a departed %s only when you gain host authority, without a second leave notice", (role) => {
  const base = live();
  const before = { ...base, participants: { ...base.participants, roster: [{ ...host, role }] } };
  const authority = createSnapshot(["endEpisode"]).self;
  const events = callEventToasts(before, { ...base, self: { ...base.self, role, capabilities: authority.capabilities, can: authority.can } });
  expect(events).toHaveLength(1);
  expect(renderToStaticMarkup(<>{events[0]?.message}</>)).toContain("Nora</b> left. You’re now the host.");
  expect(callEventToasts(before, { ...before, participants: { ...before.participants, roster: [{ ...host, role: "guest" }] } })).toHaveLength(0);
});
it("does not announce host transfer for a role name change without authority", () => {
  const base = live();
  const before = { ...base, participants: { ...base.participants, roster: [host] } };
  const events = callEventToasts(before, { ...base, self: { ...base.self, role: "host" } });
  expect(events).toHaveLength(1);
  expect(renderToStaticMarkup(<>{events[0]?.message}</>)).toContain("Nora</b> left");
  expect(renderToStaticMarkup(<>{events[0]?.message}</>)).not.toContain("now the host");
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
  expect(text).toContain("Connect one, then try again.");
  // People join from Windows, Android and iPhone too, so the copy names no platform.
  expect(text).not.toMatch(/Mac|System Settings/);
});
it("announces someone else's raised hand, but never your own, so no toast covers the tray's hand button", () => {
  const base = live();
  const me: Participant = { ...host, participantId: "self", displayName: "Ada", role: "guest", capabilities: [] };
  const before = { ...base, participants: { ...base.participants, roster: [host, me] } };
  const raise = (participantId: string) => callEventToasts(before, { ...before, participants: { ...before.participants, roster: before.participants.roster.map((person) => (person.participantId === participantId ? { ...person, handRaised: true } : person)) } });
  expect(raise("self")).toHaveLength(0);
  const events = raise("host");
  expect(events).toHaveLength(1);
  expect(renderToStaticMarkup(<>{events[0]?.message}</>)).toContain("Nora</b> raised a hand");
});

it.each(["client.internal_error", "connection.invalid_state"] as const)("does not expose internal media details for %s", (code) => {
  const toast = mediaFailureToast({ code, recoverable: true, message: "setCameraEnabled belongs to an inactive connection" }, "camera");
  const text = renderToStaticMarkup(<>{toast?.message}</>);
  expect(text).not.toContain("setCameraEnabled");
  expect(text).toBe(code === "connection.invalid_state" ? "That change was interrupted. Try again." : "Couldn’t change your camera settings. Try again.");
  expect(text).not.toMatch(/reconnect|start/);
});

it("keeps the failure code and message off the screen but on the toast for bug reports", () => {
  const toast = mediaFailureToast({ code: "connection.invalid_state", recoverable: true, message: "setCameraEnabled belongs to an inactive connection (assertActivePorts)" }, "camera");
  if (!toast) throw new Error("expected a toast");
  expect(toast.detail).toBe("connection.invalid_state: setCameraEnabled belongs to an inactive connection (assertActivePorts)");
  expect(renderToStaticMarkup(<ChalkToast {...toast} onDismiss={() => {}} />)).toContain('data-detail="connection.invalid_state: setCameraEnabled belongs to an inactive connection (assertActivePorts)"');
});

it.each(["client.internal_error", "connection.invalid_state"] as const)("preserves non-media command guidance for %s", (code) => {
  const toast = mediaFailureToast({ code, recoverable: false, message: "Recording is not allowed for this participant." });
  expect(renderToStaticMarkup(<>{toast?.message}</>)).toBe("Recording is not allowed for this participant.");
});

it.each([undefined, "camera", "microphone", "screen"] as const)("hides unhandled media failure details with source %s", (source) => {
  const toast = mediaFailureToast({ code: "media.timeout", recoverable: true, message: "setCameraEnabled belongs to an inactive connection" }, source);
  const text = renderToStaticMarkup(<>{toast?.message}</>);
  expect(text).not.toContain("setCameraEnabled");
  expect(text).not.toContain("inactive connection");
});

it("gives unsupported speaker selection safe non-retry guidance", () => {
  const toast = mediaFailureToast({ code: "environment.unsupported", recoverable: false, message: "selectSpeaker internal implementation details" }, "speaker");
  expect(renderToStaticMarkup(<>{toast?.message}</>)).toBe("This browser can’t change your speaker. Use your system sound settings to choose an output device.");
});

it.each([undefined, "camera", "microphone", "screen"] as const)("keeps expired request guidance terminal for %s", (source) => {
  const toast = mediaFailureToast({ code: "media.request_invalid", recoverable: false, message: "private request details" }, source, "request");
  expect(renderToStaticMarkup(<>{toast?.message}</>)).toBe("The media request is no longer active.");
});

it.each(["media.timeout", "media.capture_failed", "media.device_busy", "media.device_constraint_invalid", "media.permission_denied", "client.internal_error", "connection.invalid_state"] as const)("does not suggest retrying terminal %s failures", (code) => {
  const toast = mediaFailureToast({ code, recoverable: false, message: "private media details" }, "camera", "start");
  const text = renderToStaticMarkup(<>{toast?.message}</>);
  expect(text).not.toContain("private media details");
  expect(text).not.toMatch(/try again/i);
});

it.each(["camera", "microphone", "screen"] as const)("does not give start-permission advice when stopping %s fails", (source) => {
  const toast = mediaFailureToast({ code: "media.permission_denied", recoverable: true, message: "private media details" }, source, "stop");
  const text = renderToStaticMarkup(<>{toast?.message}</>);
  expect(text).toBe(source === "screen" ? "Couldn’t stop screen sharing. Try again." : `Couldn’t change your ${source} settings. Try again.`);
});
it("says why a Recording failed, once, and not as a plain stop", () => {
  const before = live();
  const failure = (failureCode: string | null) => ({ ...before, recording: { current: { recordingId: "r1", status: "failed" as const, failureCode } } });
  const unsupported = callEventToasts(before, failure("recording_capture_unsupported"));
  expect(unsupported).toHaveLength(1);
  expect(unsupported[0]?.type).toBe("error");
  expect(renderToStaticMarkup(<>{unsupported[0]?.message}</>)).toBe("Recording isn’t available in this call yet.");
  expect(renderToStaticMarkup(<>{callEventToasts(before, failure("provider_rejected"))[0]?.message}</>)).toBe("Recording failed. Try again.");
  const recording = { ...before, recording: { current: { recordingId: "r1", status: "recording" as const, failureCode: null } } };
  expect(callEventToasts(recording, failure("provider_rejected"))).toHaveLength(1);
  expect(callEventToasts(failure("provider_rejected"), failure("provider_rejected"))).toHaveLength(0);
});
