import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { addAndroidConnectionServiceListener, endAndroidConnectionServiceCall, ensureAndroidConnectionServiceRegistered, setAndroidConnectionServiceActive, startAndroidConnectionServiceCall } from "../android/connection-service";
import type { NativeVideoConferencePhase } from "./NativeVideoConference";

interface UseAndroidConnectionServiceOptions {
  displayName: string;
  enabled: boolean;
  hasVideo: boolean;
  joinNonce: number;
  onDisconnectRequest: () => void;
  phase: NativeVideoConferencePhase;
  roomId: string;
  roomName: string;
}

export function useAndroidConnectionService({ displayName, enabled, hasVideo, joinNonce, onDisconnectRequest, phase, roomId, roomName }: UseAndroidConnectionServiceOptions): void {
  const currentCallIdRef = useRef<string | null>(null);
  const currentJoinNonceRef = useRef<number | null>(null);
  const activatedCallIdRef = useRef<string | null>(null);
  const isEnabled = enabled && Platform.OS === "android";

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    void ensureAndroidConnectionServiceRegistered();
  }, [isEnabled]);

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    return addAndroidConnectionServiceListener((event) => {
      if (event.type !== "disconnect") {
        return;
      }

      if (event.callId !== currentCallIdRef.current) {
        return;
      }

      onDisconnectRequest();
    });
  }, [isEnabled, onDisconnectRequest]);

  useEffect(() => {
    if (!isEnabled || phase !== "joining") {
      return;
    }

    if (currentJoinNonceRef.current === joinNonce) {
      return;
    }

    const callId = `${roomId}:${joinNonce}`;
    currentJoinNonceRef.current = joinNonce;
    currentCallIdRef.current = callId;
    activatedCallIdRef.current = null;

    void startAndroidConnectionServiceCall({
      callId,
      displayName,
      hasVideo,
      roomId,
      roomName,
    });
  }, [displayName, hasVideo, isEnabled, joinNonce, phase, roomId, roomName]);

  useEffect(() => {
    if (!isEnabled || phase !== "meeting") {
      return;
    }

    const callId = currentCallIdRef.current;
    if (!callId || activatedCallIdRef.current === callId) {
      return;
    }

    activatedCallIdRef.current = callId;
    void setAndroidConnectionServiceActive(callId);
  }, [isEnabled, phase]);

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    const callId = currentCallIdRef.current;
    if (!callId) {
      return;
    }

    if (phase !== "lobby" && phase !== "end") {
      return;
    }

    currentCallIdRef.current = null;
    activatedCallIdRef.current = null;

    void endAndroidConnectionServiceCall(callId, {
      reason: phase === "lobby" ? "canceled" : "local",
    });
  }, [isEnabled, phase]);

  useEffect(
    () => () => {
      if (!isEnabled) {
        return;
      }

      const callId = currentCallIdRef.current;
      if (!callId) {
        return;
      }

      currentCallIdRef.current = null;
      activatedCallIdRef.current = null;
      void endAndroidConnectionServiceCall(callId, { reason: "local" });
    },
    [isEnabled],
  );
}
