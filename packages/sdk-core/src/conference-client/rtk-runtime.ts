import type RealtimeKitClient from "@cloudflare/realtimekit";
import { Effect, pipe } from "effect";
import { createOperationLock, type OperationLock } from "../effect/connection.ts";
import { ConnectionError, TimeoutError } from "../effect/errors.ts";
import { getRtkJoinPolicyForCurrentCohort } from "../rtk-join-policy.ts";
import { wideEvents } from "../wide-events/index.ts";
import { WideEventContext } from "../wide-events/context.ts";

let realtimeKitModulePromise: Promise<typeof import("@cloudflare/realtimekit")> | null = null;

const importRealtimeKitModule = async () => {
  if (realtimeKitModulePromise === null) {
    realtimeKitModulePromise = import("@cloudflare/realtimekit").catch((error) => {
      realtimeKitModulePromise = null;
      throw error;
    });
  }

  return realtimeKitModulePromise;
};

export const createJoinLock = (): OperationLock => createOperationLock();

export const loadRealtimeKitClient = async () => {
  const module = await importRealtimeKitModule();
  return module.default;
};

export const preloadRealtimeKitBundle = async (): Promise<boolean> => {
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

export const initRealtimeKit = (authToken: string, audio: boolean, video: boolean) =>
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

export const waitForJoinWithTimeout = (joinPromise: Promise<void>, timeoutMs: number) =>
  pipe(
    Effect.tryPromise({
      try: () => joinPromise,
      catch: (error) =>
        new ConnectionError({
          code: "CONNECTION_FAILED",
          message: error instanceof Error ? error.message : "RTK join failed",
          recoverable: true,
          cause: error,
        }),
    }),
    Effect.timeout(`${timeoutMs} millis`),
    Effect.flatMap((option) =>
      option !== null
        ? Effect.succeed(option)
        : Effect.fail(
            new TimeoutError({
              message: `ConferenceSession join timed out after ${timeoutMs}ms`,
              operation: "joinRTKRoom",
              timeoutMs,
            }),
          ),
    ),
  );

export const isJoinTimeoutError = (error: Error): boolean => {
  if (error instanceof TimeoutError) {
    return true;
  }
  return error.message.toLowerCase().includes("timed out");
};

const emitRtkJoinAttemptTelemetry = ({
  attempt,
  totalAttempts,
  timeoutMs,
  delayMs,
  attemptDurationMs,
  timeoutVsError,
  outcome,
  errorMessage,
  joinPolicySelection,
}: {
  attempt: number;
  totalAttempts: number;
  timeoutMs: number;
  delayMs: number;
  attemptDurationMs: number;
  timeoutVsError: "timeout" | "error" | "none";
  outcome: "success" | "timeout" | "error";
  errorMessage?: string;
  joinPolicySelection: ReturnType<typeof getRtkJoinPolicyForCurrentCohort>;
}): void => {
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

export const joinRealtimeKitWithRetry = async (rtkClient: RealtimeKitClient, joinPolicySelection = getRtkJoinPolicyForCurrentCohort()): Promise<void> => {
  let lastError: Error | null = null;
  let joinPromise: Promise<void> | null = null;
  const retryDelays = joinPolicySelection.policy.retryDelaysMs;
  const timeoutMs = joinPolicySelection.policy.timeoutMs;
  const totalAttempts = 1 + retryDelays.length;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const attemptNumber = attempt + 1;
    const attemptStart = performance.now();

    if (!joinPromise) {
      joinPromise = rtkClient.join();
    }

    try {
      await Effect.runPromise(waitForJoinWithTimeout(joinPromise, timeoutMs));
      emitRtkJoinAttemptTelemetry({
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
      const isTimeout = isJoinTimeoutError(normalized);
      const delayMs = attempt < retryDelays.length ? retryDelays[attempt]! : 0;

      emitRtkJoinAttemptTelemetry({
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
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(`Failed to join room after ${totalAttempts} attempts: ${lastError?.message}`);
};
