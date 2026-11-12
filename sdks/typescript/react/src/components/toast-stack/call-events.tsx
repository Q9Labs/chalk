import { commandFailurePresentation, type MediaCommandSource, type MediaCommandAction } from "../control-bar/command-failure";
import { CallEventIcon } from "./CallEventIcon";
import { Avatar } from "../atomic/Avatar";
import { callEvents, getRecordingFailureDetail, type CallEvent, type ClientFailure, type Participant, type SpaceSnapshot } from "@q9labsai/chalk-client";
import type { Toast } from "./ToastStack";

export function mediaFailureToast(failure: ClientFailure | null, source?: MediaCommandSource, action?: MediaCommandAction, onRetry?: () => void): Omit<Toast, "id"> | null {
  if (!failure) return null;
  const presentation = commandFailurePresentation(failure, source, action, onRetry !== undefined);
  return { icon: <CallEventIcon kind={source ?? "microphone"} error />, type: "error", message: presentation.message, action: presentation.retry && onRetry ? { label: "Try again", onClick: onRetry } : undefined };
}

const name = (participant: Participant) => (
  <b style={{ fontWeight: 600 }} dir="auto">
    {participant.displayName}
  </b>
);
const avatar = (participant: Participant) => <Avatar name={participant.displayName} size="xs" style={{ width: 28, height: 28 }} generated animated={false} />;

/** The toast a call event gets on the web, or null when the web says nothing for it. */
export function callEventToast(event: CallEvent): Omit<Toast, "id"> | null {
  switch (event.kind) {
    case "joined":
      return { icon: avatar(event.participant), message: <>{name(event.participant)} joined</> };
    case "left":
      return { icon: avatar(event.participant), message: <>{name(event.participant)} left</> };
    case "handRaised":
      return { icon: <CallEventIcon kind="hand" />, message: <>{name(event.participant)} raised a hand</> };
    case "shareStopped":
      return { icon: <CallEventIcon kind="screen" />, message: <>{name(event.participant)} stopped sharing</> };
    case "hostChanged":
      return {
        icon: <CallEventIcon kind="host" />,
        message: event.previousHost ? (
          <>
            {name(event.previousHost)}
            {" left. You’re now the host."}
          </>
        ) : (
          "You’re now the host."
        ),
      };
    case "recordingStarted":
      return {
        icon: <CallEventIcon kind="recording" error />,
        message: (
          <>
            <b style={{ fontWeight: 600 }}>Recording started.</b> Everyone in the call can see it.
          </>
        ),
      };
    case "recordingStopped":
      return { icon: <CallEventIcon kind="recording" />, message: "Recording stopped" };
    case "recordingFailed":
      return { icon: <CallEventIcon kind="recording" error />, type: "error", message: getRecordingFailureDetail(event.failureCode) };
    case "deviceSwitched":
      return {
        icon: <CallEventIcon kind={event.source === "microphone" ? "microphone-on" : event.source} />,
        message: (
          <>
            {`${event.from || event.source} disconnected. Switched to `}
            <b style={{ fontWeight: 600 }}>{event.to || event.source}</b>
          </>
        ),
      };
    case "mutedByHost":
    case "mediaRequest":
      return null;
  }
}

/** The toasts for what changed between two snapshots, for previews that have no client. */
export function callEventToasts(previous: SpaceSnapshot, next: SpaceSnapshot): Omit<Toast, "id">[] {
  return callEvents(previous, next).flatMap((event) => callEventToast(event) ?? []);
}
