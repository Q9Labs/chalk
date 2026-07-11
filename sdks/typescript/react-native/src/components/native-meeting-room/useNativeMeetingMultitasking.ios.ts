import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { meetingMultitasking } from "../../native/meeting-multitasking.ios";
import { reportMultitaskingFailure, useNativeMeetingMultitaskingConfig, type NativeMeetingMultitaskingInput } from "./useNativeMeetingMultitasking.shared";

export function useNativeMeetingMultitasking(input: NativeMeetingMultitaskingInput) {
  const appStateRef = useRef(AppState.currentState);
  const config = useNativeMeetingMultitaskingConfig(input);

  useEffect(() => {
    void meetingMultitasking.setPictureInPictureEnabled(true).catch((cause) => {
      reportMultitaskingFailure("enable PiP", cause);
    });

    return () => {
      void meetingMultitasking.setPictureInPictureEnabled(false).catch((cause) => {
        reportMultitaskingFailure("disable PiP", cause);
      });
      void meetingMultitasking.stopPictureInPicture().catch(() => {});
    };
  }, []);

  useEffect(() => {
    void meetingMultitasking.updatePictureInPictureConfig(config).catch((cause) => {
      reportMultitaskingFailure("update PiP config", cause);
    });
  }, [config]);

  useEffect(() => {
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
