import { ControlApiError, AssignmentError, isTerminalFailure, safeErrorCode } from "./errors.js";
import { loggerOf, reportRetry } from "./queue.js";
import type { JobQueue } from "./queue.js";
import type { CleanupAssignment, DispatcherDependencies, JourneyContext } from "./types.js";

export function cleanupQueue(dependencies: DispatcherDependencies): JobQueue<CleanupAssignment> {
  return {
    logPrefix: "cleanup",
    claim: async (limit, journey) => (await dependencies.control.claimCleanup({ limit, context: journey })).assignments,
    process: async (assignment, journey) => ((await processCleanup(dependencies, assignment, journey)) ? "completed" : "failed"),
    release: (assignment, journey) => retryCleanup(dependencies, assignment, journey, "timeout_reserve", false),
  };
}

async function processCleanup(dependencies: DispatcherDependencies, assignment: CleanupAssignment, journey: JourneyContext): Promise<boolean> {
  const logger = loggerOf(dependencies);
  try {
    const response = await dependencies.fetch(assignment.deleteUrl, { method: "DELETE" });
    if (response.status !== 404 && !response.ok) throw new AssignmentError("cleanup delete failed", response.status === 408 || response.status === 429 || response.status >= 500);
    await dependencies.control.completeCleanup({ assignment, context: journey });
    logger.info("cleanup_completed", { absent: response.status === 404 });
    return true;
  } catch (error) {
    if (error instanceof ControlApiError && error.status === 409) {
      logger.warn("cleanup_late_or_duplicate_completion_rejected");
      return false;
    }
    const errorCode = error instanceof AssignmentError ? (error.retryable ? "cleanup_delete_retryable" : "cleanup_delete_failed") : safeErrorCode(error);
    await retryCleanup(dependencies, assignment, journey, errorCode, isTerminalFailure(error));
    return false;
  }
}

function retryCleanup(dependencies: DispatcherDependencies, assignment: CleanupAssignment, journey: JourneyContext, errorCode: string, terminal: boolean): Promise<void> {
  return reportRetry(loggerOf(dependencies), "cleanup", () => dependencies.control.retryCleanup({ assignment, errorCode, terminal, context: journey }));
}
