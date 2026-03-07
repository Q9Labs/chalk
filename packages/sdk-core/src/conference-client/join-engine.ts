import { Effect } from "effect";
import { ConnectionError, TimeoutError } from "../effect/errors.ts";
import { getRtkJoinPolicyForCurrentCohort } from "../rtk-join-policy.ts";
import { WideEventContext } from "../wide-events/context.ts";
import { wideEvents } from "../wide-events/index.ts";
import type RealtimeKitClient from "@cloudflare/realtimekit";

export type RtkJoinPolicySelection = ReturnType<typeof getRtkJoinPolicyForCurrentCohort>;

export interface RtkJoinAttemptTelemetry {
  attempt: number;
  totalAttempts: number;
  timeoutMs: number;
  delayMs: number;
  attemptDurationMs: number;
  timeoutVsError: "timeout" | "error" | "none";
  outcome: "success" | "timeout" | "error";
  errorMessage?: string;
  joinPolicySelection: RtkJoinPolicySelection;
}

export const emitRtkJoinAttemptTelemetry = ({ attempt, totalAttempts, timeoutMs, delayMs, attemptDurationMs, timeoutVsError, outcome, errorMessage, joinPolicySelection }: RtkJoinAttemptTelemetry): void => {
  const attemptCtx = new WideEventContext("room.join.rtk.attempt", wideEvents.collector);
  attemptCtx.merge({
    attempt,
    totalAttempts,
    timeoutMs,
    delayMs,
    attemptDurationMs,
    timeoutVsError,
    outcome,
    rtkJoinPolicy: joinPolicySelection,
  });

  if (outcome === "success") {
    attemptCtx.complete("success");
    return;
  }

  attemptCtx.complete(outcome, {
    code: timeoutVsError === "timeout" ? "RTK_JOIN_TIMEOUT" : "RTK_JOIN_ERROR",
    message: errorMessage ?? "RTK join attempt failed",
  });
};

export const createRealtimeKitInitEffect = (
  authToken: string,
  audio: boolean,
  video: boolean,
  loadRealtimeKitClient: () => Promise<{
    init: (config: { authToken: string; defaults: { audio: boolean; video: boolean } }) => Promise<RealtimeKitClient>;
  }>,
) =>
  Effect.tryPromise({
    try: async () => {
      const realtimeKitClient = await loadRealtimeKitClient();
      return realtimeKitClient.init({
        authToken,
        defaults: { audio, video },
      });
    },
    catch: (error) =>
      new ConnectionError({
        code: "CONNECTION_FAILED",
        message: error instanceof Error ? error.message : "RealtimeKit init failed",
        recoverable: true,
        cause: error,
      }),
  });

export const preloadRealtimeKitBundle = async (loadRealtimeKitClient: () => Promise<unknown>): Promise<boolean> => {
  const ctx = wideEvents.start("room.join.rtk.preload");

  try {
    await loadRealtimeKitClient();
    ctx.complete("success");
    return true;
  } catch (error) {
    ctx.complete("error", error);
    return false;
  }
};

interface JoinRealtimeKitWithRetryDeps {
  waitForJoin: (joinPromise: Promise<void>, timeoutMs: number) => Promise<void>;
  isJoinTimeoutError: (error: Error) => boolean;
  emitAttemptTelemetry: (telemetry: RtkJoinAttemptTelemetry) => void;
  sleep?: (delayMs: number) => Promise<void>;
}

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

export const joinRealtimeKitWithRetry = async (rtkClient: { join: () => Promise<void> }, joinPolicySelection: RtkJoinPolicySelection, deps: JoinRealtimeKitWithRetryDeps): Promise<void> => {
  let lastError: Error | null = null;
  let joinPromise: Promise<void> | null = null;
  const retryDelays = joinPolicySelection.policy.retryDelaysMs;
  const timeoutMs = joinPolicySelection.policy.timeoutMs;
  const totalAttempts = 1 + retryDelays.length;
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const attemptNumber = attempt + 1;
    const attemptStart = performance.now();

    if (!joinPromise) {
      joinPromise = rtkClient.join();
    }

    try {
      await deps.waitForJoin(joinPromise, timeoutMs);
      deps.emitAttemptTelemetry({
        attempt: attemptNumber,
        totalAttempts,
        timeoutMs,
        delayMs: 0,
        attemptDurationMs: Math.round(performance.now() - attemptStart),
        timeoutVsError: "none",
        outcome: "success",
        joinPolicySelection,
      });
      return;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      lastError = normalized;
      const isTimeout = normalized instanceof TimeoutError || deps.isJoinTimeoutError(normalized);
      const delayMs = attempt < retryDelays.length ? (retryDelays[attempt] ?? 0) : 0;

      deps.emitAttemptTelemetry({
        attempt: attemptNumber,
        totalAttempts,
        timeoutMs,
        delayMs,
        attemptDurationMs: Math.round(performance.now() - attemptStart),
        timeoutVsError: isTimeout ? "timeout" : "error",
        outcome: isTimeout ? "timeout" : "error",
        errorMessage: normalized.message,
        joinPolicySelection,
      });

      if (!isTimeout) {
        joinPromise = null;
      }

      if (attempt < retryDelays.length) {
        await sleep(delayMs);
      }
    }
  }

  throw new Error(`Failed to join room after ${totalAttempts} attempts: ${lastError?.message}`);
};
