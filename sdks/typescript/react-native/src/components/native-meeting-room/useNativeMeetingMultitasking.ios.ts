import { useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { meetingMultitasking } from "../../native/meeting-multitasking.ios";
import { NativeMeetingMultitaskingController, type NativeMeetingMultitaskingAppState } from "../native-meeting-multitasking-controller";
import { reportMultitaskingFailure, useNativeMeetingMultitaskingConfig, type NativeMeetingMultitaskingInput } from "./useNativeMeetingMultitasking.shared";

export function useNativeMeetingMultitasking(input: NativeMeetingMultitaskingInput) {
  const config = useNativeMeetingMultitaskingConfig(input);
  const appState = useMemo<NativeMeetingMultitaskingAppState>(
    () => ({
      currentState: AppState.currentState,
      addEventListener: (listener) => AppState.addEventListener("change", listener),
    }),
    [],
  );
  const controller = useMemo(
    () =>
      new NativeMeetingMultitaskingController({
        platform: "ios",
        appState,
        module: meetingMultitasking,
        reportFailure: reportMultitaskingFailure,
      }),
    [appState],
  );

  controller.update(config);
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
