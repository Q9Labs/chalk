import { useEffect, useMemo, useRef } from "react";
import { AppState, Platform } from "react-native";
import type { ParticipantState } from "../../internal/core";
import type { ResolvedNativeMeetingLayout } from "../../utils/native-meeting-layout";
import { meetingMultitasking } from "../../native/meeting-multitasking";
import { resolveNativeMeetingMultitaskingSource } from "./meeting-multitasking-source";

type RoomParticipant = ParticipantState["participants"][number];

function reportMultitaskingFailure(action: string, cause: unknown) {
  console.warn(`Native meeting multitasking failed during ${action}:`, cause);
}

function buildStreamURL(track: MediaStreamTrack | null): string | null {
  if (!track) {
    return null;
  }

  try {
    const { MediaStream } = require("@cloudflare/react-native-webrtc") as typeof import("@cloudflare/react-native-webrtc");
    return new MediaStream([track as never]).toURL();
  } catch {
    return null;
  }
}

export function useNativeMeetingMultitasking({
  activeSpeaker,
  allParticipants,
  derived,
  isCameraOff,
  isMuted,
  localParticipant,
  roomName,
  selfName,
}: {
  activeSpeaker: RoomParticipant | null;
  allParticipants: readonly RoomParticipant[];
  derived: ResolvedNativeMeetingLayout;
  isCameraOff: boolean;
  isMuted: boolean;
  localParticipant: RoomParticipant | null;
  roomName: string;
  selfName: string;
}) {
  const appStateRef = useRef(AppState.currentState);

  const source = useMemo(
    () =>
      resolveNativeMeetingMultitaskingSource({
        activeSpeaker,
        allParticipants,
        derived,
        localParticipant,
        selfName,
      }),
    [activeSpeaker, allParticipants, derived, localParticipant, selfName],
  );
  const streamURL = useMemo(() => buildStreamURL(source.track), [source.track]);

  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      return;
    }

    void meetingMultitasking.setPictureInPictureEnabled(true).catch((cause) => {
      reportMultitaskingFailure("enable PiP", cause);
    });

    return () => {
      void meetingMultitasking.setPictureInPictureEnabled(false).catch((cause) => {
        reportMultitaskingFailure("disable PiP", cause);
      });
      void meetingMultitasking.stopPictureInPicture().catch(() => {});
      void meetingMultitasking.stopBackgroundMode().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      return;
    }

    const config = {
      roomName,
      participantName: source.participantName,
      streamURL,
      muted: isMuted,
      cameraOff: isCameraOff,
    };

    void meetingMultitasking.updatePictureInPictureConfig(config).catch((cause) => {
      reportMultitaskingFailure("update PiP config", cause);
    });

    if (Platform.OS === "android") {
      void meetingMultitasking.startBackgroundMode(config).catch((cause) => {
        reportMultitaskingFailure("start Android background mode", cause);
      });
    }
  }, [isCameraOff, isMuted, roomName, source.participantName, streamURL]);

  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      return;
    }

    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;

      if (previousState === "active" && nextState !== "active") {
        void meetingMultitasking.startPictureInPicture().catch((cause) => {
          reportMultitaskingFailure("start PiP on background", cause);
        });
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);
}
