import { CallEventIcon } from "./CallEventIcon";
import { Avatar } from "../atomic/Avatar";
import type { ClientFailure, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { Toast } from "./ToastStack";

export function mediaFailureToast(error: ClientFailure, source?: "microphone" | "camera" | "screen"): Omit<Toast, "id"> {
  const device = source ?? "device";
  if (source === "screen") return { icon: <CallEventIcon kind={source ?? "microphone"} error />, type: "error", message: "Your screen couldn’t be shared. Allow screen recording for your browser in System Settings, then try again." };
  if (error.code === "media.device_not_found") return { icon: <CallEventIcon kind={source ?? "microphone"} error />, type: "error", message: `No ${device} found. Plug one in, or check that your device can see it in System Settings.` };
  if (error.code === "media.permission_denied")
    return { icon: <CallEventIcon kind={source ?? "microphone"} error />, type: "error", message: `Chalk can’t use your ${device}. Click the camera icon in the address bar and allow ${source === "camera" ? "Camera" : source === "microphone" ? "Microphone" : "Camera and Microphone"}.` };
  return { icon: <CallEventIcon kind={source ?? "microphone"} error />, type: "error", message: error.message };
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
        icon: <Avatar name={person.displayName} size="xs" generated animated={false} />,
        message: (
          <>
            <b dir="auto">{person.displayName}</b> joined
          </>
        ),
      });
    if (old && !old.handRaised && person.handRaised) events.push({ icon: <CallEventIcon kind="hand" />, message: `${person.displayName} raised a hand` });
    if (old && old.role !== person.role && person.role === "host") events.push({ icon: <CallEventIcon kind="host" />, message: `${person.displayName} is now the host` });
    if (old?.media.screenShare === "active" && person.media.screenShare === "inactive") events.push({ icon: <CallEventIcon kind="screen" />, message: `${person.displayName} stopped sharing` });
  }
  for (const person of previous.participants.roster)
    if (!after.has(person.participantId) && person.participantId !== next.self.participantId)
      events.push({
        icon: <Avatar name={person.displayName} size="xs" generated animated={false} />,
        message: (
          <>
            <b dir="auto">{person.displayName}</b> left
          </>
        ),
      });
  const wasRecording = previous.recording.current?.status === "recording";
  const isRecording = next.recording.current?.status === "recording";
  if (wasRecording !== isRecording) events.push({ icon: <CallEventIcon kind="recording" error={isRecording} />, message: isRecording ? "Recording started. Everyone in the call can see it." : "Recording stopped" });
  for (const source of ["microphone", "camera"] as const) {
    if (previous.media.selection[source] !== next.media.selection[source]) {
      const devices = source === "camera" ? next.media.devices.cameras : next.media.devices.microphones;
      const selected = devices.find((device) => device.deviceId === next.media.selection[source]);
      if (selected) events.push({ icon: <CallEventIcon kind={source ?? "microphone"} />, message: `Switched to ${selected.label || source}` });
    }
  }
  return events;
}
