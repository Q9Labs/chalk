import { createHash, randomUUID } from "node:crypto";
import { AssignmentError, ControlApiError, providerFailureKind, safeErrorCode } from "./errors.js";
import { InvocationCircuit, transcribeWithFallback } from "./retry.js";
import { normalizeTranscriptChunk, serializeTranscript } from "./normalize.js";
import { validateSpeakerTurnManifest } from "./urls.js";
import { conditionalPutJson, fetchAudioChunk } from "./storage.js";
import { runCleanupDispatcher } from "./cleanup.js";
import { runFinalizeDispatcher } from "./finalizer.js";
import type { ControlApi, DispatcherContext, DispatcherEvent, DispatcherLogger, DispatcherContext as LambdaContext, JourneyContext, ReleaseConfig, TranscriptionAssignment, TranscriptionProvider } from "./types.js";

export interface DispatcherDependencies {
  config: ReleaseConfig;
  control: ControlApi;
  primary?: TranscriptionProvider;
  fallback: TranscriptionProvider;
  fetch: typeof fetch;
  logger?: DispatcherLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_LOGGER: DispatcherLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export async function runDispatcher(event: DispatcherEvent = {}, context: DispatcherContext, dependencies: DispatcherDependencies, maxClaims?: number): Promise<{ claimed: number; completed: number; failed: number }> {
  if (event.source === "cleanup") return runCleanupDispatcher(event, context, dependencies, maxClaims);
  if (event.source === "finalize") return runFinalizeDispatcher(event, context, dependencies, maxClaims);
  if (event.source === "reconcile" || event.source === "eventbridge.scheduler" || (event.kind === "transcription-reconcile" && event.source !== "wake")) return runReconcileDispatcher(event, context, dependencies);
  const logger = dependencies.logger ?? DEFAULT_LOGGER;
  const now = dependencies.now ?? Date.now;
  const contextHeaders: JourneyContext = {
    journeyId: event.journeyId ?? randomUUID(),
    ...(event.traceparent === undefined ? {} : { traceparent: event.traceparent }),
    ...(event.tracestate === undefined ? {} : { tracestate: event.tracestate }),
  };
  const circuit = new InvocationCircuit(dependencies.config.provider.circuitFailureThreshold, dependencies.config.provider.circuitCooldownMs);
  let claimed = 0;
  let completed = 0;
  let failed = 0;
  const assignments: TranscriptionAssignment[] = [];
  const configuredLimit = Math.min(dependencies.config.maxBatch, dependencies.config.concurrency, 50);
  const limit = Math.min(configuredLimit, maxClaims ?? configuredLimit);
  if (limit <= 0) return { claimed, completed, failed };
  if (context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) {
    logger.info("dispatcher_timeout_reserve_reached");
    return { claimed, completed, failed };
  }
  const claim = await dependencies.control.claim({ limit, context: contextHeaders });
  assignments.push(...claim.assignments);
  claimed = assignments.length;
  logger.info("dispatcher_claimed", { count: claimed, source: event.source ?? "wake" });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, assignments.length) }, async () => {
    while (cursor < assignments.length) {
      const assignment = assignments[cursor];
      cursor += 1;
      if (!assignment) return;
      if (context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) {
        await safeRetry(dependencies.control, assignment, contextHeaders, "timeout_reserve", false, logger);
        failed += 1;
        continue;
      }
      const result = await processAssignment(assignment, contextHeaders, context, dependencies, circuit, now);
      if (result === "completed") completed += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);
  return { claimed, completed, failed };
}

/**
 * The minute scheduler emits one reconcile event. Keep that event useful for
 * every durable queue while sharing one bounded claim/concurrency budget.
 */
async function runReconcileDispatcher(event: DispatcherEvent, context: DispatcherContext, dependencies: DispatcherDependencies): Promise<{ claimed: number; completed: number; failed: number }> {
  const total = Math.min(dependencies.config.maxBatch, dependencies.config.concurrency, 50);
  const budget = allocateReconcileBudget(total);
  const tasks = [] as Array<Promise<{ claimed: number; completed: number; failed: number }>>;
  if (budget.transcription > 0) tasks.push(runDispatcher({ ...event, source: "wake" }, context, dependencies, budget.transcription));
  if (budget.finalize > 0 && dependencies.control.claimFinalize && dependencies.control.completeFinalize && dependencies.control.retryFinalize) tasks.push(runFinalizeDispatcher(event, context, dependencies, budget.finalize));
  if (budget.cleanup > 0 && dependencies.control.claimCleanup && dependencies.control.completeCleanup && dependencies.control.retryCleanup) tasks.push(runCleanupDispatcher(event, context, dependencies, budget.cleanup));
  const results = await Promise.all(tasks);
  return results.reduce((totalResult, result) => ({ claimed: totalResult.claimed + result.claimed, completed: totalResult.completed + result.completed, failed: totalResult.failed + result.failed }), { claimed: 0, completed: 0, failed: 0 });
}

function allocateReconcileBudget(total: number): { transcription: number; finalize: number; cleanup: number } {
  if (total <= 0) return { transcription: 0, finalize: 0, cleanup: 0 };
  if (total === 1) return { transcription: 1, finalize: 0, cleanup: 0 };
  if (total === 2) return { transcription: 1, finalize: 1, cleanup: 0 };
  const each = Math.floor(total / 3);
  return { transcription: each + (total % 3), finalize: each, cleanup: each };
}

async function processAssignment(assignment: TranscriptionAssignment, journey: JourneyContext, context: DispatcherContext, dependencies: DispatcherDependencies, circuit: InvocationCircuit, now: () => number): Promise<"completed" | "failed"> {
  const logger = dependencies.logger ?? DEFAULT_LOGGER;
  try {
    await dependencies.control.heartbeat({ assignment, context: journey });
    const chunkDurationSeconds = (assignment.chunk.meetingEndMs - assignment.chunk.meetingStartMs) / 1_000;
    if (chunkDurationSeconds > dependencies.config.provider.maxAudioSeconds) throw new Error("audio duration bound exceeded");
    const audio = await fetchAudioChunk({
      fetch: dependencies.fetch,
      url: assignment.chunk.inputUrl,
      expectedContentType: assignment.chunk.inputContentType,
      expectedSizeBytes: assignment.chunk.inputSizeBytes,
      expectedSha256: assignment.chunk.inputSha256,
      maxBytes: dependencies.config.provider.maxAudioBytes,
    });
    const manifestBytes = await fetchAudioChunk({
      fetch: dependencies.fetch,
      url: assignment.manifest.inputUrl,
      expectedContentType: assignment.manifest.contentType,
      expectedSizeBytes: assignment.manifest.sizeBytes,
      expectedSha256: assignment.manifest.sha256,
      maxBytes: dependencies.config.provider.maxResponseBytes,
    });
    let manifest: ReturnType<typeof validateSpeakerTurnManifest>;
    try {
      manifest = validateSpeakerTurnManifest(JSON.parse(new TextDecoder().decode(manifestBytes.bytes)) as unknown);
    } catch {
      throw new AssignmentError("speaker turn manifest is invalid");
    }
    const transcription = await transcribeWithFallback({
      ...(dependencies.primary === undefined ? {} : { primary: dependencies.primary }),
      fallback: dependencies.fallback,
      request: { audio: audio.bytes, contentType: audio.contentType, chunkId: assignment.chunk.chunkId },
      policy: dependencies.config.provider,
      circuit,
      runtime: {
        ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
        ...(dependencies.random === undefined ? {} : { random: dependencies.random }),
        now,
      },
    });
    const document = normalizeTranscriptChunk({
      jobId: assignment.jobId,
      sessionId: assignment.sessionId,
      meetingStartMs: assignment.chunk.meetingStartMs,
      meetingEndMs: assignment.chunk.meetingEndMs,
      manifest,
      provider: transcription.result,
      attempt: assignment.attempt,
      measuredAudioMs: assignment.chunk.meetingEndMs - assignment.chunk.meetingStartMs,
      sourceIdentity: assignment.chunk.sourceIdentity,
      sourceTrackClass: assignment.chunk.sourceTrackClass,
    });
    const body = serializeTranscript(document);
    if (body.byteLength > dependencies.config.provider.maxResponseBytes) throw new AssignmentError("normalized transcript exceeded bound");
    const checksumSha256 = createHash("sha256").update(body).digest("hex");
    const upload = await conditionalPutJson({ fetch: dependencies.fetch, url: assignment.outputPutUrl, body, checksumSha256 });
    if (upload === "already_exists") {
      logger.warn("dispatcher_duplicate_result_rejected");
      return "failed";
    }
    await dependencies.control.complete({
      jobId: assignment.jobId,
      attempt: assignment.attempt,
      leaseToken: assignment.leaseToken,
      checksumSha256,
      sizeBytes: body.byteLength,
      contentType: assignment.outputContentType,
      provider: transcription.result.provider,
      model: transcription.result.model,
      versionContract: transcription.result.versionContract,
      ...(transcription.result.executionIdentity === undefined ? {} : { executionIdentity: transcription.result.executionIdentity }),
      ...(transcription.result.providerIdentity?.requestId === undefined ? {} : { providerRequestId: transcription.result.providerIdentity.requestId }),
      ...(transcription.result.language === undefined ? {} : { language: transcription.result.language }),
      measuredAudioMs: assignment.chunk.meetingEndMs - assignment.chunk.meetingStartMs,
      ...(transcription.result.durationMs === undefined ? {} : { providerObservedDurationMs: transcription.result.durationMs }),
      ...(transcription.result.quality === undefined ? {} : { quality: transcription.result.quality }),
      context: journey,
    });
    logger.info("dispatcher_completed", { provider: transcription.result.provider, fallback: transcription.usedFallback, attempts: transcription.providerAttempts });
    return "completed";
  } catch (error) {
    if (error instanceof ControlApiError && error.status === 409) {
      logger.warn("dispatcher_late_or_duplicate_completion_rejected");
      return "failed";
    }
    const kind = providerFailureKind(error);
    const terminal = kind === "nonretryable" || kind === "schema";
    await safeRetry(dependencies.control, assignment, journey, safeErrorCode(error), terminal, logger);
    return "failed";
  }
}

async function safeRetry(control: ControlApi, assignment: TranscriptionAssignment, context: JourneyContext, errorCode: string, terminal: boolean, logger: DispatcherLogger): Promise<void> {
  try {
    await control.retry({
      jobId: assignment.jobId,
      attempt: assignment.attempt,
      leaseToken: assignment.leaseToken,
      errorCode,
      terminal,
      context,
    });
  } catch (retryError) {
    logger.warn("dispatcher_retry_report_failed", { error: safeErrorCode(retryError) });
  }
}

export function createLambdaHandler(dependencies: Omit<DispatcherDependencies, "config"> & { config: ReleaseConfig }) {
  return (event: DispatcherEvent, context: LambdaContext): Promise<{ claimed: number; completed: number; failed: number }> => runDispatcher(event, context, dependencies);
}
