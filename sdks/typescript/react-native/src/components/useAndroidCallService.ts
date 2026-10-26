import { useEffect } from "react";
import { AppState } from "react-native";
import { startAndroidCallService, stopAndroidCallService } from "../android/call-service";
import { useConnection, useMedia } from "../hooks/space-hooks";

/**
 * Runs the Android foreground service for as long as the person is in the call, so the microphone
 * and camera keep working in the background. It starts again when the microphone or camera turns on,
 * because that's when the person has granted the permission the service declares, and on every return
 * to the foreground, because Android can refuse a start made while the app is in the background.
 */
export function useAndroidCallService(): void {
  const connection = useConnection();
  const media = useMedia();
  const inCall = connection.status === "live" || connection.status === "reconnecting";
  const microphoneOn = media.local.microphone.state === "enabled";
  const cameraOn = media.local.camera.state === "enabled";

  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing Android call-service ownership and cleanup.
  useEffect(() => {
    if (!inCall) return;
    const start = () => {
      startAndroidCallService().catch((error: unknown) => {
        console.warn("Failed to start the Android call service", error);
      });
    };
    start();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") start();
    });
    return () => subscription.remove();
  }, [inCall, microphoneOn, cameraOn]);

  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing Android call-service ownership and cleanup.
  useEffect(() => {
    if (!inCall) return;
    return () => {
      stopAndroidCallService().catch((error: unknown) => {
        console.warn("Failed to stop the Android call service", error);
      });
    };
  }, [inCall]);
}
