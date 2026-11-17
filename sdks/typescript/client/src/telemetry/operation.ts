import type { MediaOperationResult, MediaOperationStart, TelemetryDraft, TelemetrySink } from "./types";

const MAX_MILLISECONDS = 2_147_483_647;

/** Records `media_intent` now and returns the function that records the matching `media_result` once, with the time since the intent. */
export function startOperation(record: (draft: TelemetryDraft) => void, clock: { readonly now: () => number; readonly uuid: () => string }, start: MediaOperationStart): (result: MediaOperationResult) => void {
  const operation = { action: start.action, source: start.source, op_id: start.op_id ?? clock.uuid() };
  const startedAt = clock.now();
  let settled = false;
  record({ type: "media_intent", ...operation });
  return (result) => {
    if (settled) return;
    settled = true;
    record({ type: "media_result", ...operation, ...result, duration_ms: Math.min(MAX_MILLISECONDS, Math.max(0, Math.round(clock.now() - startedAt))) });
  };
}

/**
 * Runs one media operation and tells the sink how it started and how it ended. `failure` says in closed words why a rejection happened,
 * and the rejection itself goes on to the caller unchanged.
 */
export function observeOperation<T>(sink: TelemetrySink | undefined, start: MediaOperationStart, run: () => Promise<T>, failure: (error: unknown) => Omit<MediaOperationResult, "outcome">, shortfall?: (result: T) => Omit<MediaOperationResult, "outcome"> | undefined): Promise<T> {
  const done = sink?.operation(start);
  if (!done) return run();
  let pending: Promise<T>;
  try {
    pending = run();
  } catch (error) {
    done({ outcome: "failed", ...failure(error) });
    throw error;
  }
  return pending.then(
    (result) => {
      const partial = shortfall?.(result);
      done(partial ? { outcome: "failed", ...partial } : { outcome: "succeeded" });
      return result;
    },
    (error: unknown) => {
      done({ outcome: "failed", ...failure(error) });
      throw error;
    },
  );
}
