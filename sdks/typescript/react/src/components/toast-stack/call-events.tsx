import { CallEventIcon } from "./CallEventIcon";
import { Avatar } from "../atomic/Avatar";
import type { ClientFailure, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { Toast } from "./ToastStack";

export function mediaFailureToast(failure: ClientFailure | null, source?: "microphone" | "camera" | "screen"): Omit<Toast, "id"> | null {
  if (!failure) return null;
  const device = source ?? "device";
  const icon = <CallEventIcon kind={source ?? "microphone"} error />;
  if (source === "screen" && failure.code.startsWith("media.")) return { icon, type: "error", message: "Your screen couldn’t be shared. Allow screen recording for your browser in System Settings, then try again." };
  if (failure.code === "media.permission_denied") return { icon, type: "error", message: `Allow ${device} access. Click the camera icon in the address bar and allow ${source === "camera" ? "Camera" : source === "microphone" ? "Microphone" : "Camera and Microphone"}.` };
  if (failure.code === "media.device_not_found") return { icon, type: "error", message: `No ${device} found. Plug one in, or check that your device can see it in System Settings.` };
  if (failure.code === "media.device_busy") return { icon, type: "error", message: `Your ${device} is being used by another app. Close it there, then try again.` };
  if (failure.code === "media.device_constraint_invalid") return { icon, type: "error", message: `Your ${device} doesn’t support these settings. Choose another ${device}, then try again.` };
  if (failure.code === "media.capture_failed") return { icon, type: "error", message: `Your ${device} couldn’t start. Check that it is connected and available, then try again.` };
  return { icon, type: "error", message: failure.message };
}

/** Snapshot changes, not initial history, are events for the person already in the call. */
export function callEventToasts(previous: SpaceSnapshot, next: SpaceSnapshot): Omit<Toast, "id">[] {
  if (previous.connection.status !== "live" || next.connection.status !== "live") return [];
  const events: Omit<Toast, "id">[] = [];
  const before = new Map(previous.participants.roster.map((p) => [p.participantId, p]));
  const after = new Map(next.participants.roster.map((p) => [p.participantId, p]));
  for (const person of next.participants.roster) {
    const old = before.get(person.participantId);
    if (!old && person.participantId !== next.self.participantId)
      events.push({
        icon: <Avatar name={person.displayName} size="xs" style={{ width: 28, height: 28 }} generated animated={false} />,
        message: (
          <>
            <b dir="auto">{person.displayName}</b> joined
          </>
        ),
      });
    if (old && !old.handRaised && person.handRaised)
      events.push({
        icon: <CallEventIcon kind="hand" />,
        message: (
          <>
            <b dir="auto">{person.displayName}</b> raised a hand
          </>
        ),
      });
    if (old && old.role !== person.role && person.role === "host")
      events.push({
        icon: <CallEventIcon kind="host" />,
        message: (
          <>
            <b dir="auto">{person.displayName}</b> is now the host
          </>
        ),
      });
    if (old?.media.screenShare === "active" && person.media.screenShare === "inactive")
      events.push({
        icon: <CallEventIcon kind="screen" />,
        message: (
          <>
            <b dir="auto">{person.displayName}</b> stopped sharing
          </>
        ),
      });
  }
  for (const person of previous.participants.roster)
    if (!after.has(person.participantId) && person.participantId !== next.self.participantId)
      events.push({
        icon: <Avatar name={person.displayName} size="xs" style={{ width: 28, height: 28 }} generated animated={false} />,
        message: (
          <>
            <b dir="auto">{person.displayName}</b> left
          </>
        ),
      });
  const wasRecording = previous.recording.current?.status === "recording";
  const isRecording = next.recording.current?.status === "recording";
  if (wasRecording !== isRecording)
    events.push({
      icon: <CallEventIcon kind="recording" error={isRecording} />,
      message: isRecording ? (
        <>
          <b>Recording started.</b> Everyone in the call can see it.
        </>
      ) : (
        "Recording stopped"
      ),
    });
  for (const source of ["microphone", "camera"] as const) {
    if (previous.media.selection[source] !== next.media.selection[source]) {
      const devices = source === "camera" ? next.media.devices.cameras : next.media.devices.microphones;
      const selected = devices.find((device) => device.deviceId === next.media.selection[source]);
      if (selected) events.push({ icon: <CallEventIcon kind={source ?? "microphone"} />, message: `Switched to ${selected.label || source}` });
    }
  }
  return events;
}
