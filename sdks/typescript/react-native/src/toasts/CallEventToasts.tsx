import { SpaceClientError, type SpaceClient } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useRef } from "react";
import { Linking, Platform } from "react-native";
import { FaceAvatar } from "../avatar/FaceAvatar";
import { useSpaceClient } from "../context/space-client-context";
import { usePreferences } from "../frame/preferences";
import { Icon, type IconName } from "../icons/Icon";
import type { ToastInput } from "../primitives/toast/toast-store";
import { useToasts } from "../primitives/toast/ToastStack";
import { playSound, type SoundName } from "../sounds/sounds";
import { useTheme } from "../theme/theme";
import type { Palette } from "../theme/tokens";
import { callNotices, firstName, type Notice } from "./notices";

/** A device the call asks the OS for. */
export type Permission = "microphone" | "camera";

type Toasts = ReturnType<typeof useToasts>;

export type CallEventToasts = {
  /** Call before the person turns their own microphone off, so it isn't reported as a host mute. */
  readonly noteOwnMicrophoneChange: () => void;
  /** Says why turning on the microphone or camera failed, with the way forward (F1, K1, K2). */
  readonly reportMediaFailure: (permission: Permission, cause: unknown, retry: () => void) => void;
};

export type CallEventToastsOptions = {
  /** Called just before Open Settings leaves the app, so the app can rejoin after iOS restarts it. */
  readonly onOpenSettings?: (permission: Permission) => void;
  /** The app restarted after the person allowed this in Settings; says so once the call is live. */
  readonly resumedAfterSettings?: Permission;
};

/**
 * Turns call events into notices and sounds through the one toast stack: people joining and
 * leaving (F5, F6), a host muting you (F8), requests to unmute (F3), a new host (F10), a share
 * ending (F11), recording starting and stopping, and failed microphone or camera changes.
 */
export function useCallEventToasts({ onOpenSettings, resumedAfterSettings }: CallEventToastsOptions): CallEventToasts {
  const client = useSpaceClient();
  const toasts = useToasts();
  const { colors } = useTheme();
  const { soundsEnabled } = usePreferences();
  const ownMicrophoneChange = useRef(false);
  const latest = useRef({ colors, soundsEnabled });
  latest.current = { colors, soundsEnabled };

  useEffect(() => {
    let previous = client.getSnapshot();
    return client.subscribe(() => {
      const next = client.getSnapshot();
      if (next === previous) return;
      const notices = callNotices(previous, next, ownMicrophoneChange.current);
      if (previous.media.local.microphone.state !== next.media.local.microphone.state) ownMicrophoneChange.current = false;
      previous = next;
      for (const notice of notices) {
        let id = 0;
        const { input, sound } = noticeToast(notice, { client, toasts, colors: latest.current.colors, dismiss: () => toasts.dismiss(id) });
        id = toasts.show(input);
        if (sound) playSound(sound, latest.current.soundsEnabled);
      }
    });
  }, [client, toasts]);

  useResumedAfterSettings(resumedAfterSettings, toasts);

  const noteOwnMicrophoneChange = useCallback(() => {
    ownMicrophoneChange.current = true;
  }, []);

  const reportMediaFailure = useCallback(
    (permission: Permission, cause: unknown, retry: () => void) => {
      const code = cause instanceof SpaceClientError ? cause.code : null;
      const icon: IconName = permission === "microphone" ? "micOff" : "camOff";
      const leading = <Icon color={latest.current.colors.dangerText} name={icon} />;
      playSound("error", latest.current.soundsEnabled);
      if (code === "media.permission_denied") {
        const id = toasts.show({
          kind: "error",
          leading,
          wrap: true,
          dismissible: true,
          testID: `toast.${permission}-denied`,
          message: [{ strong: `Chalk can’t use your ${permission}.` }, Platform.OS === "ios" ? ` Allow it in Settings, then turn your ${permission} back on.` : " Allow it in Settings."],
          actions: [
            {
              label: "Open Settings",
              testID: "toast.open-settings",
              onPress: () => {
                toasts.dismiss(id);
                onOpenSettings?.(permission);
                void Linking.openSettings();
              },
            },
          ],
        });
        return;
      }
      if (code === "media.device_busy") {
        const id = toasts.show({
          kind: "error",
          leading,
          dismissible: true,
          testID: `toast.${permission}-busy`,
          message: `Another app is using your ${permission}`,
          actions: [
            {
              label: "Try again",
              testID: "toast.try-again",
              onPress: () => {
                toasts.dismiss(id);
                retry();
              },
            },
          ],
        });
        return;
      }
      toasts.show({ kind: "error", leading, dismissible: true, wrap: true, message: cause instanceof Error ? `Couldn’t turn on your ${permission}. ${cause.message}` : `Couldn’t turn on your ${permission}.` });
    },
    [onOpenSettings, toasts],
  );

  return { noteOwnMicrophoneChange, reportMediaFailure };
}

/** After Open Settings on iOS the OS restarts Chalk; once the call is live again, say why it rejoined. */
function useResumedAfterSettings(permission: Permission | undefined, toasts: Toasts): void {
  const client = useSpaceClient();
  const { colors } = useTheme();
  const shown = useRef(false);
  useEffect(() => {
    if (!permission) return;
    const check = () => {
      if (shown.current || client.getSnapshot().connection.status !== "live") return;
      shown.current = true;
      toasts.show({ leading: <Icon color={colors.textMuted} name="check" />, message: `You’re back in the call. Chalk can use your ${permission} now.`, testID: "toast.resumed" });
    };
    check();
    return client.subscribe(check);
  }, [client, colors, permission, toasts]);
}

type NoticeContext = {
  readonly client: SpaceClient;
  readonly toasts: Toasts;
  readonly colors: Palette;
  /** Dismisses this notice, for actions that act on it. */
  readonly dismiss: () => void;
};

function noticeToast(notice: Notice, { client, toasts, colors, dismiss }: NoticeContext): { readonly input: ToastInput; readonly sound?: SoundName } {
  const icon = (name: IconName, tone: "muted" | "danger" = "muted") => <Icon color={tone === "danger" ? colors.dangerText : colors.textMuted} name={name} />;
  const avatar = (name: string) => <FaceAvatar name={name} size={28} />;
  switch (notice.kind) {
    case "joined":
      return { input: { leading: avatar(notice.name), message: [{ strong: notice.name }, " joined"], testID: "toast.joined" }, sound: "join" };
    case "left":
      return { input: { leading: avatar(notice.name), message: [{ strong: notice.name }, " left"], testID: "toast.left" }, sound: "leave" };
    case "mutedByHost":
      return {
        input: notice.by ? { leading: avatar(notice.by), message: [{ strong: notice.by }, " muted you. Unmute when you’re ready."], testID: "toast.muted-by-host" } : { leading: icon("micOff"), message: "You were muted. Unmute when you’re ready.", testID: "toast.muted-by-host" },
        sound: "mute",
      };
    case "mediaRequest": {
      const { request } = notice;
      const who = request.actorDisplayName ? firstName(request.actorDisplayName) : "The host";
      const unmute = request.kind === "unmute";
      const accept = () => {
        dismiss();
        client.media.acceptRequest(request.requestId).catch(() => toasts.show({ kind: "error", dismissible: true, message: unmute ? "Couldn’t unmute you." : "Couldn’t turn on your camera." }));
      };
      return {
        input: {
          leading: icon(unmute ? "mic" : "cam"),
          message: unmute ? `${who} asks you to unmute` : `${who} asks you to turn on your camera`,
          testID: "toast.media-request",
          actions: [{ label: unmute ? "Unmute" : "Turn on", variant: "primary", testID: "toast.accept-request", onPress: accept }],
        },
      };
    }
    case "newHost":
      return { input: { leading: icon("users"), message: [{ strong: notice.previousHost }, " left. You’re now the host."], testID: "toast.new-host" }, sound: "leave" };
    case "shareStopped":
      return { input: { leading: icon("shareOff"), message: [{ strong: notice.name }, " stopped sharing"], testID: "toast.share-stopped" } };
    case "recordingStarted":
      return { input: { leading: icon("rec", "danger"), message: [{ strong: "Recording started." }, " Everyone in the call can see it."], testID: "toast.recording-started" }, sound: "recording" };
    case "recordingStopped":
      return { input: { leading: icon("rec"), message: "Recording stopped", testID: "toast.recording-stopped" } };
  }
}
