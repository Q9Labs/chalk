import { ChalkErrorCode, wideEvents, type ChalkError } from "@q9labs/chalk-core";
import { useCallback, type MutableRefObject } from "react";

import type { JoinSettings } from "../PreJoinLobby";
import { toChalkError } from "./join-errors";
import type { Phase } from "./types";

export type JoinPhaseTransitionTarget = Phase | "failure";
export type PostJoinDeviceSelectionKind = "camera" | "microphone" | "speaker";

interface UseJoinFlowTelemetryParams {
  roomId: string;
  phaseRef: MutableRefObject<Phase>;
  pushIncidentBreadcrumb: (category: string, message: string, data?: Record<string, unknown>) => void;
}

export function useJoinFlowTelemetry({ roomId, phaseRef, pushIncidentBreadcrumb }: UseJoinFlowTelemetryParams) {
  const emitJoinClickTelemetry = useCallback(
    (settings: JoinSettings, data?: Record<string, unknown>) => {
      const ctx = wideEvents.start("ui.join.click");
      ctx.merge({
        roomId,
        phase: phaseRef.current,
        displayName: settings.displayName,
        audioEnabled: settings.audioEnabled,
        videoEnabled: settings.videoEnabled,
        selectedVideoDevice: settings.selectedVideoDevice,
        selectedAudioInput: settings.selectedAudioInput,
        selectedAudioOutput: settings.selectedAudioOutput,
        ...(data ?? {}),
      });
      ctx.complete("success");
    },
    [phaseRef, roomId],
  );

  const emitJoinPhaseTransitionTelemetry = useCallback(
    (fromPhase: Phase, toPhase: JoinPhaseTransitionTarget, data?: Record<string, unknown>, errorForTelemetry?: ChalkError) => {
      const ctx = wideEvents.start("ui.join.phase_transition");
      ctx.merge({
        roomId,
        fromPhase,
        toPhase,
        transition: `${fromPhase}->${toPhase}`,
        ...(data ?? {}),
      });
      if (toPhase === "failure") {
        ctx.complete(
          "error",
          errorForTelemetry ?? {
            code: ChalkErrorCode.UNKNOWN_ERROR,
            message: "Join failed",
          },
        );
        return;
      }
      ctx.complete("success");
    },
    [roomId],
  );

  const selectMediaDevicePostJoin = useCallback(
    async (deviceKind: PostJoinDeviceSelectionKind, deviceId: string, select: (id: string) => Promise<void>): Promise<void> => {
      const ctx = wideEvents.start("ui.media.device_selection");
      ctx.merge({
        roomId,
        deviceKind,
        deviceId,
        trigger: "post_join_click",
      });
      ctx.markPhase("select_device");
      const startedAt = performance.now();

      try {
        await select(deviceId);
        ctx.complete("success", {
          outcome: "selected",
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      } catch (rawError) {
        const chalkError = toChalkError(rawError);
        ctx.set("outcome", "failed");
        ctx.set("durationMs", Math.max(0, Math.round(performance.now() - startedAt)));
        ctx.complete("error", chalkError);
        pushIncidentBreadcrumb("media", "Post-click media device selection failed", {
          deviceKind,
          deviceId,
          code: chalkError.code,
          message: chalkError.message,
        });
      }
    },
    [pushIncidentBreadcrumb, roomId],
  );

  return {
    emitJoinClickTelemetry,
    emitJoinPhaseTransitionTelemetry,
    selectMediaDevicePostJoin,
  };
}
