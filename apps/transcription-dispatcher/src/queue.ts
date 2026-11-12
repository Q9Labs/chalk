import { randomUUID } from "node:crypto";
import { safeErrorCode } from "./errors.js";
import type { DispatcherContext, DispatcherDependencies, DispatcherEvent, DispatcherLogger, JourneyContext } from "./types.js";

export interface RunSummary {
  claimed: number;
  completed: number;
  failed: number;
}

/** One durable control-plane queue: claim leased assignments, process each, hand back what time ran out on. */
export interface JobQueue<Assignment> {
  /** Names the queue's log events, such as `dispatcher_claimed`. */
  readonly logPrefix: string;
  claim(limit: number, journey: JourneyContext): Promise<Assignment[]>;
  process(assignment: Assignment, journey: JourneyContext): Promise<"completed" | "failed">;
  release(assignment: Assignment, journey: JourneyContext): Promise<void>;
}

const NOOP_LOGGER: DispatcherLogger = { info: () => undefined, warn: () => undefined };

export function loggerOf(dependencies: DispatcherDependencies): DispatcherLogger {
  return dependencies.logger ?? NOOP_LOGGER;
}

export function journeyFor(event: DispatcherEvent): JourneyContext {
  return {
    journeyId: event.journeyId || randomUUID(),
    ...(event.traceparent === undefined ? {} : { traceparent: event.traceparent }),
    ...(event.tracestate === undefined ? {} : { tracestate: event.tracestate }),
  };
}

/** The first queue takes the remainder, so a steady backlog there cannot starve the others. */
export function splitBudget(total: number, queues: number): number[] {
  const each = Math.floor(total / queues);
  return Array.from({ length: queues }, (_, index) => (index === 0 ? total - each * (queues - 1) : each));
}

/** Reports a retry to the control plane. A failed report is logged, because the lease expiring does the same retry. */
export async function reportRetry(logger: DispatcherLogger, logPrefix: string, report: () => Promise<void>): Promise<void> {
  try {
    await report();
  } catch (error) {
    logger.warn(`${logPrefix}_retry_report_failed`, { error: safeErrorCode(error) });
  }
}

export async function drainQueue<Assignment>(queue: JobQueue<Assignment>, limit: number, journey: JourneyContext, context: DispatcherContext, dependencies: DispatcherDependencies): Promise<RunSummary> {
  const logger = loggerOf(dependencies);
  const outOfTime = () => context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs;
  if (limit <= 0) return { claimed: 0, completed: 0, failed: 0 };
  if (outOfTime()) {
    logger.info(`${queue.logPrefix}_timeout_reserve_reached`);
    return { claimed: 0, completed: 0, failed: 0 };
  }
  const assignments = await queue.claim(limit, journey);
  logger.info(`${queue.logPrefix}_claimed`, { count: assignments.length });
  let completed = 0;
  let failed = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, assignments.length) }, async () => {
    while (cursor < assignments.length) {
      const assignment = assignments[cursor];
      cursor += 1;
      if (assignment === undefined) return;
      if (outOfTime()) {
        await queue.release(assignment, journey);
        failed += 1;
        continue;
      }
      if ((await queue.process(assignment, journey)) === "completed") completed += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);
  return { claimed: assignments.length, completed, failed };
}
