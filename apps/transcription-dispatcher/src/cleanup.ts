import { randomUUID } from "node:crypto";
import { ControlApiError, AssignmentError, providerFailureKind, safeErrorCode } from "./errors.js";
import type { CleanupAssignment, DispatcherContext, DispatcherEvent, DispatcherLogger, JourneyContext } from "./types.js";
import type { DispatcherDependencies } from "./dispatcher.js";

const NOOP_LOGGER: DispatcherLogger = { info: () => undefined, warn: () => undefined };

export async function runCleanupDispatcher(event: DispatcherEvent, context: DispatcherContext, dependencies: DispatcherDependencies, maxClaims?: number): Promise<{ claimed: number; completed: number; failed: number }> {
  const logger = dependencies.logger ?? NOOP_LOGGER;
  const claimCleanup = dependencies.control.claimCleanup;
  if (!claimCleanup) throw new Error("cleanup control API is not configured");
  const journey: JourneyContext = {
    journeyId: event.journeyId ?? randomUUID(),
    ...(event.traceparent === undefined ? {} : { traceparent: event.traceparent }),
    ...(event.tracestate === undefined ? {} : { tracestate: event.tracestate }),
  };
  const configuredLimit = Math.min(dependencies.config.maxBatch, dependencies.config.concurrency, 50);
  const limit = Math.min(configuredLimit, maxClaims ?? configuredLimit);
  if (limit <= 0) return { claimed: 0, completed: 0, failed: 0 };
  if (context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) {
    logger.info("cleanup_timeout_reserve_reached");
    return { claimed: 0, completed: 0, failed: 0 };
  }
  const claim = await claimCleanup({ limit, context: journey });
  let cursor = 0;
  let completed = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.min(limit, claim.assignments.length) }, async () => {
    while (cursor < claim.assignments.length) {
      const assignment = claim.assignments[cursor];
      cursor += 1;
      if (!assignment) return;
      if (context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) {
        await retryCleanup(dependencies, assignment, journey, "timeout_reserve", false, logger);
        failed += 1;
        continue;
      }
      if (await processCleanup(dependencies, assignment, journey, logger)) completed += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);
  return { claimed: claim.assignments.length, completed, failed };
}

async function processCleanup(dependencies: DispatcherDependencies, assignment: CleanupAssignment, journey: JourneyContext, logger: DispatcherLogger): Promise<boolean> {
  try {
    const response = await dependencies.fetch(assignment.deleteUrl, { method: "DELETE" });
    if (response.status !== 404 && !response.ok) throw new AssignmentError("cleanup delete failed", response.status === 408 || response.status === 429 || response.status >= 500);
    if (!dependencies.control.completeCleanup) throw new Error("cleanup completion API is not configured");
    await dependencies.control.completeCleanup({ assignment, context: journey });
    logger.info("cleanup_completed", { absent: response.status === 404 });
    return true;
  } catch (error) {
    if (error instanceof ControlApiError && error.status === 409) {
      logger.warn("cleanup_late_or_duplicate_completion_rejected");
      return false;
    }
    const errorCode = error instanceof AssignmentError ? (error.retryable ? "cleanup_delete_retryable" : "cleanup_delete_failed") : safeErrorCode(error);
    await retryCleanup(dependencies, assignment, journey, errorCode, providerFailureKind(error) === "nonretryable" || providerFailureKind(error) === "schema", logger);
    return false;
  }
}

async function retryCleanup(dependencies: DispatcherDependencies, assignment: CleanupAssignment, journey: JourneyContext, errorCode: string, terminal: boolean, logger: DispatcherLogger): Promise<void> {
  try {
    if (!dependencies.control.retryCleanup) throw new Error("cleanup retry API is not configured");
    await dependencies.control.retryCleanup({ assignment, errorCode, terminal, context: journey });
  } catch (error) {
    logger.warn("cleanup_retry_report_failed", { error: safeErrorCode(error) });
  }
}
