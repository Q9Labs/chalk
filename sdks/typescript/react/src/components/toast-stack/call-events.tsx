import { commandFailureMessage, type MediaCommandSource, type MediaCommandAction } from "../control-bar/command-failure";
import { CallEventIcon } from "./CallEventIcon";
import { Avatar } from "../atomic/Avatar";
import type { ClientFailure, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { Toast } from "./ToastStack";

export function mediaFailureToast(failure: ClientFailure | null, source?: MediaCommandSource, action?: MediaCommandAction): Omit<Toast, "id"> | null {
  if (!failure) return null;
  return { icon: <CallEventIcon kind={source ?? "microphone"} error />, type: "error", message: commandFailureMessage(failure, source, action) };
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
            <b style={{ fontWeight: 600 }} dir="auto">
              {person.displayName}
            </b>{" "}
            joined
          </>
        ),
      });
    // Your own hand needs no toast: it would sit over the tray's hand button and block lowering it.
    if (old && !old.handRaised && person.handRaised && person.participantId !== next.self.participantId)
      events.push({
        icon: <CallEventIcon kind="hand" />,
        message: (
          <>
            <b style={{ fontWeight: 600 }} dir="auto">
              {person.displayName}
            </b>{" "}
            raised a hand
          </>
        ),
      });
    if (old?.media.screenShare === "active" && person.media.screenShare === "inactive")
      events.push({
        icon: <CallEventIcon kind="screen" />,
        message: (
          <>
            <b style={{ fontWeight: 600 }} dir="auto">
              {person.displayName}
            </b>{" "}
            stopped sharing
          </>
        ),
      });
  }
  const departedHost = previous.participants.roster.find((person) => person.capabilities.includes("endEpisode") && !after.has(person.participantId));
  const becameHost = !previous.self.can("endEpisode") && next.self.can("endEpisode");
  if (becameHost)
    events.push({
      icon: <CallEventIcon kind="host" />,
      message: departedHost ? (
        <>
          <b style={{ fontWeight: 600 }} dir="auto">
            {departedHost.displayName}
          </b>
          {" left. You’re now the host."}
        </>
      ) : (
        "You’re now the host."
      ),
    });
  for (const person of previous.participants.roster)
    if (!after.has(person.participantId) && person.participantId !== next.self.participantId && !(person === departedHost && becameHost))
      events.push({
        icon: <Avatar name={person.displayName} size="xs" style={{ width: 28, height: 28 }} generated animated={false} />,
        message: (
          <>
            <b style={{ fontWeight: 600 }} dir="auto">
              {person.displayName}
            </b>{" "}
            left
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
          <b style={{ fontWeight: 600 }}>Recording started.</b> Everyone in the call can see it.
        </>
      ) : (
        "Recording stopped"
      ),
    });
  for (const source of ["microphone", "camera"] as const) {
    if (previous.media.selection[source] !== next.media.selection[source]) {
      const devices = source === "camera" ? next.media.devices.cameras : next.media.devices.microphones;
      const oldDevices = source === "camera" ? previous.media.devices.cameras : previous.media.devices.microphones;
      const disconnected = oldDevices.find((device) => device.deviceId === previous.media.selection[source]);
      if (!disconnected || devices.some((device) => device.deviceId === disconnected.deviceId)) continue;
      const selected = devices.find((device) => device.deviceId === next.media.selection[source]);
      if (selected)
        events.push({
          icon: <CallEventIcon kind={source === "microphone" ? "microphone-on" : source} />,
          message: (
            <>
              {`${disconnected.label || source} disconnected. Switched to `}
              <b style={{ fontWeight: 600 }}>{selected.label || source}</b>
            </>
          ),
        });
    }
  }
  return events;
}
