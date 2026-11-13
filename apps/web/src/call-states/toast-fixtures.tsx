import { useState, type ReactNode } from "react";
import { ToastStack } from "@q9labsai/chalk-react";
import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { Avatar } from "../../../../sdks/typescript/react/src/components/atomic/Avatar";
import { callEventToasts, mediaFailureToast } from "../../../../sdks/typescript/react/src/components/toast-stack/call-events";
import { PEOPLE, liveSnapshot } from "./fixtures";

type ToastEvent = NonNullable<ReturnType<typeof callEventToasts>[number]>;

/** The one production toast a snapshot change raises. */
function eventToast(before: SpaceSnapshot, after: SpaceSnapshot): ToastEvent {
  const toast = callEventToasts(before, after)[0];
  if (!toast) throw new Error("No production toast event");
  return toast;
}

const mutedToast = {
  message: (
    <>
      <b style={{ fontWeight: 600 }}>Nora</b> muted you. Unmute when you’re ready.
    </>
  ),
  icon: <Avatar name="Nora" size="xs" style={{ width: 28, height: 28 }} animated={false} />,
};

function hostTransferToast(previous: SpaceSnapshot): ToastEvent {
  const before = { ...previous, participants: { ...previous.participants, roster: previous.participants.roster.map((p) => (p.participantId === previous.self.participantId ? p : { ...p, role: "host" as const, displayName: "Nora" })) } };
  const after = { ...previous, self: { ...previous.self, role: "host" as const }, participants: { ...previous.participants, roster: previous.participants.roster.filter((p) => p.participantId === previous.self.participantId) } };
  return eventToast(before, after);
}

function deviceToast(previous: SpaceSnapshot): ToastEvent {
  const old = { deviceId: "airpods", label: "AirPods Pro" };
  const selected = { deviceId: "built-in", label: "MacBook Air Microphone" };
  const before = { ...previous, media: { ...previous.media, selection: { ...previous.media.selection, microphone: old.deviceId }, devices: { ...previous.media.devices, microphones: [old, selected] } } };
  const after = { ...before, media: { ...before.media, selection: { ...before.media.selection, microphone: selected.deviceId }, devices: { ...before.media.devices, microphones: [selected] } } };
  return eventToast(before, after);
}

/** The snapshot the call moves to for the fixtures that start from one remote person. */
function changedSnapshot(id: string, previous: SpaceSnapshot): SpaceSnapshot {
  switch (id) {
    case "hand":
      return { ...previous, participants: { ...previous.participants, roster: previous.participants.roster.map((p) => (p.participantId === previous.self.participantId ? p : { ...p, handRaised: true })) } };
    case "recording-failed":
      return { ...previous, recording: { ...previous.recording, current: { recordingId: "fixture", status: "failed", failureCode: "recording_capture_unsupported" } } };
    case "recording":
      return { ...previous, recording: { ...previous.recording, current: { recordingId: "fixture", status: "recording", failureCode: null } } };
    default:
      return liveSnapshot({ others: PEOPLE.slice(0, 1) });
  }
}

export function toastForFixture(id: string) {
  if (id === "camera" || id === "share-blocked") return mediaFailureToast({ code: "media.permission_denied", message: "Blocked", recoverable: true }, id === "camera" ? "camera" : "screen") ?? { message: "" };
  if (id === "muted") return mutedToast;
  const previous = liveSnapshot({ others: id === "joined" ? [] : PEOPLE.slice(0, 1) });
  if (id === "host") return hostTransferToast(previous);
  if (id === "device") return deviceToast(previous);
  return eventToast(previous, changedSnapshot(id, previous));
}

export function ToastFixture({ message, icon, action, error = false, light = false }: { readonly message: ReactNode; readonly icon?: ReactNode; readonly action?: { readonly label: string; readonly onClick: () => void }; readonly error?: boolean; readonly light?: boolean }) {
  const [visible, setVisible] = useState(true);
  return (
    <main data-chalk data-chalk-theme={light ? "light" : "dark"} className="chalk-root relative h-dvh bg-[var(--chalk-canvas)]" style={{ fontSize: "var(--type-body)", lineHeight: 1.4 }}>
      {visible ? (
        <ToastStack
          toasts={[
            {
              id: "fixture",
              message:
                error && typeof message === "string" && message.includes(". ") ? (
                  <>
                    <b style={{ fontWeight: 600 }}>{message.slice(0, message.indexOf(". ") + 1)}</b> {message.slice(message.indexOf(". ") + 2)}
                  </>
                ) : (
                  message
                ),
              icon,
              type: error ? "error" : "info",
              duration: Infinity,
              action,
            },
          ]}
          onDismiss={() => setVisible(false)}
        />
      ) : null}
    </main>
  );
}
