import { cleanupQueue } from "./cleanup.js";
import { finalizeQueue } from "./finalizer.js";
import { drainQueue, journeyFor, splitBudget } from "./queue.js";
import type { RunSummary } from "./queue.js";
import { transcriptionQueue } from "./transcriber.js";
import type { DispatcherContext, DispatcherDependencies, DispatcherEvent } from "./types.js";

type DispatcherSource = NonNullable<DispatcherEvent["source"]>;

// A wake-up from the API names one queue; the minute scheduler reconciles all of them, sharing one claim budget.
const QUEUES_BY_SOURCE = {
  wake: ["transcription"],
  finalize: ["finalize"],
  cleanup: ["cleanup"],
  reconcile: ["transcription", "finalize", "cleanup"],
  "eventbridge.scheduler": ["transcription", "finalize", "cleanup"],
} as const satisfies Record<DispatcherSource, readonly ("transcription" | "finalize" | "cleanup")[]>;

export async function runDispatcher(event: DispatcherEvent = {}, context: DispatcherContext, dependencies: DispatcherDependencies): Promise<RunSummary> {
  const journey = journeyFor(event);
  const queues = QUEUES_BY_SOURCE[event.source ?? "wake"];
  const budgets = splitBudget(Math.min(dependencies.config.maxBatch, dependencies.config.concurrency), queues.length);
  const results = await Promise.all(
    queues.map((name, index) => {
      const limit = budgets[index] ?? 0;
      if (name === "transcription") return drainQueue(transcriptionQueue(context, dependencies), limit, journey, context, dependencies);
      if (name === "finalize") return drainQueue(finalizeQueue(context, dependencies), limit, journey, context, dependencies);
      return drainQueue(cleanupQueue(dependencies), limit, journey, context, dependencies);
    }),
  );
  return results.reduce((total, result) => ({ claimed: total.claimed + result.claimed, completed: total.completed + result.completed, failed: total.failed + result.failed }));
}

export function createLambdaHandler(dependencies: DispatcherDependencies) {
  return (event: DispatcherEvent, context: DispatcherContext): Promise<RunSummary> => runDispatcher(event, context, dependencies);
}
