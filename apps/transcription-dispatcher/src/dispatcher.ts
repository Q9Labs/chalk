import { createHash } from "node:crypto";
import { AssignmentError, ControlApiError, ProviderError, isTerminalFailure, providerFailureKind, providerSchemaFields, safeErrorCode } from "./errors.js";
import { isReasonWord } from "./provider-utils.js";
import { InvocationCircuit, transcribeWithFallback } from "./retry.js";
import { normalizeTranscriptChunk, serializeTranscript } from "./normalize.js";
import { validateSpeakerTurnManifest } from "./speaker-turn-manifest.js";
import { conditionalPutJson, fetchVerified } from "./storage.js";
import { cleanupQueue } from "./cleanup.js";
import { finalizeQueue } from "./finalizer.js";
import { drainQueue, journeyFor, loggerOf, reportRetry, splitBudget } from "./queue.js";
import type { JobQueue, RunSummary } from "./queue.js";
import type { ControlApi, DispatcherContext, DispatcherDependencies, DispatcherEvent, DispatcherLogger, JourneyContext, TranscriptionAssignment } from "./types.js";

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

function transcriptionQueue(context: DispatcherContext, dependencies: DispatcherDependencies): JobQueue<TranscriptionAssignment> {
  const logger = loggerOf(dependencies);
  const now = dependencies.now ?? Date.now;
  const { circuitFailureThreshold, circuitCooldownMs } = dependencies.config.provider;
  const fixedCircuit = new InvocationCircuit(circuitFailureThreshold, circuitCooldownMs);
  const autoCircuit = new InvocationCircuit(circuitFailureThreshold, circuitCooldownMs);
  return {
    logPrefix: "dispatcher",
    claim: async (limit, journey) => (await dependencies.control.claim({ limit, context: journey })).assignments,
    process: (assignment, journey) => processAssignment(assignment, journey, context, dependencies, assignment.transcriptLanguage?.mode === "fixed" ? fixedCircuit : autoCircuit, now),
    release: (assignment, journey) => safeRetry(dependencies.control, assignment, journey, "timeout_reserve", false, logger),
  };
}

async function processAssignment(assignment: TranscriptionAssignment, journey: JourneyContext, context: DispatcherContext, dependencies: DispatcherDependencies, circuit: InvocationCircuit, now: () => number): Promise<"completed" | "failed"> {
  const logger = loggerOf(dependencies);
  try {
    await dependencies.control.heartbeat({ assignment, context: journey });
    const chunkDurationSeconds = (assignment.chunk.episodeEndMs - assignment.chunk.episodeStartMs) / 1_000;
    if (chunkDurationSeconds > dependencies.config.provider.maxAudioSeconds) throw new AssignmentError("audio duration bound exceeded");
    const audio = await fetchVerified({
      fetch: dependencies.fetch,
      url: assignment.chunk.inputUrl,
      expectedContentType: assignment.chunk.inputContentType,
      expectedSizeBytes: assignment.chunk.inputSizeBytes,
      expectedSha256: assignment.chunk.inputSha256,
      maxBytes: dependencies.config.provider.maxAudioBytes,
    });
    const manifestBytes = await fetchVerified({
      fetch: dependencies.fetch,
      url: assignment.manifest.inputUrl,
      expectedContentType: assignment.manifest.contentType,
      expectedSizeBytes: assignment.manifest.sizeBytes,
      expectedSha256: assignment.manifest.sha256,
      maxBytes: dependencies.config.provider.maxResponseBytes,
    });
    let manifest: ReturnType<typeof validateSpeakerTurnManifest>;
    try {
      manifest = validateSpeakerTurnManifest(JSON.parse(new TextDecoder().decode(manifestBytes.bytes)) as unknown, assignment);
    } catch {
      throw new AssignmentError("speaker turn manifest is invalid");
    }
    const auto = (assignment.transcriptLanguage?.mode ?? "auto") === "auto";
    if (auto && !dependencies.codeswitch) throw new ProviderError("Auto transcription provider is unavailable", "retryable");
    const primary = auto ? dependencies.codeswitch : dependencies.primary;
    const transcription = await transcribeWithFallback({
      ...(primary ? { primary } : {}),
      ...(!auto && dependencies.fallback ? { fallback: dependencies.fallback } : {}),
      request: {
        signal: AbortSignal.timeout(Math.max(1, context.getRemainingTimeInMillis() - dependencies.config.timeoutReserveMs)),
        transcriptLanguage: assignment.transcriptLanguage ?? { mode: "auto" },
        audio: audio.bytes,
        contentType: audio.contentType,
        chunkId: assignment.chunk.chunkId,
        onTimingRepair: (repair) => logger.warn("provider_segment_timing_repaired", { ...repair }),
      },
      policy: dependencies.config.provider,
      circuit,
      runtime: {
        ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
        ...(dependencies.random === undefined ? {} : { random: dependencies.random }),
        now,
      },
    });
    const document = normalizeTranscriptChunk({
      transcriptLanguage: assignment.transcriptLanguage ?? { mode: "auto" },
      jobId: assignment.jobId,
      episodeId: assignment.episodeId,
      episodeStartMs: assignment.chunk.episodeStartMs,
      episodeEndMs: assignment.chunk.episodeEndMs,
      sourceStartMs: assignment.chunk.sourceStartMs,
      sourceEndMs: assignment.chunk.sourceEndMs,
      manifest,
      provider: transcription.result,
      attempt: assignment.attempt,
      measuredAudioMs: assignment.chunk.episodeEndMs - assignment.chunk.episodeStartMs,
      sourceIdentity: assignment.chunk.sourceIdentity,
      sourceTrackClass: assignment.chunk.sourceTrackClass,
    });
    const body = serializeTranscript(document);
    if (body.byteLength > dependencies.config.provider.maxResponseBytes) throw new AssignmentError("normalized transcript exceeded bound");
    const checksumSha256 = createHash("sha256").update(body).digest("hex");
    const upload = await conditionalPutJson({ fetch: dependencies.fetch, url: assignment.outputPutUrl, body, checksumSha256 });
    if (upload === "already_exists") {
      // The control plane verifies the existing object against this checksum,
      // size, and content type before accepting completion. That makes a
      // retry after a successful PUT but transient completion failure safe.
      logger.warn("dispatcher_existing_result_verified_by_completion");
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
      measuredAudioMs: assignment.chunk.episodeEndMs - assignment.chunk.episodeStartMs,
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
    await reportAssignmentFailure(error, assignment, journey, dependencies.control, logger);
    return "failed";
  }
}

// The error code is stored only by the control plane, so a terminal failure needs this line to have a reason anywhere else.
export async function reportAssignmentFailure(error: unknown, assignment: TranscriptionAssignment, journey: JourneyContext, control: Pick<ControlApi, "retry">, logger: DispatcherLogger): Promise<void> {
  const kind = providerFailureKind(error);
  const terminal = isTerminalFailure(error);
  if (error instanceof ProviderError && error.kind === "schema") logger.warn("provider_schema_invalid", { ...providerSchemaFields(error) });
  const errorCode = safeErrorCode(error);
  logger.warn("dispatcher_assignment_failed", {
    jobId: assignment.jobId,
    journeyId: journey.journeyId,
    errorCode,
    kind,
    terminal,
    attempt: assignment.attempt,
    ...(error instanceof ProviderError && error.status !== undefined ? { providerStatus: error.status } : {}),
    ...(error instanceof ProviderError && error.providerCode !== undefined && isReasonWord(error.providerCode) ? { providerReason: error.providerCode } : {}),
    reason: failureReason(error),
  });
  await safeRetry(control, assignment, journey, errorCode, terminal, logger, creditRetryAt(error, assignment));
}

// OpenRouter answers 402 when the credit is short or the chunks of one recording together exceed its in-flight budget; both pass within minutes, so the attempts wait 20, 40 and 60 seconds instead of burning the control plane's four attempts at once.
function creditRetryAt(error: unknown, assignment: Pick<TranscriptionAssignment, "attempt">): string | undefined {
  if (!(error instanceof ProviderError) || error.status !== 402 || error.kind !== "retryable") return undefined;
  return new Date(Date.now() + 20_000 * assignment.attempt).toISOString();
}

// Only our own errors have fixed messages; anything else can carry a signed URL or provider data, so it logs only its class.
function failureReason(error: unknown): string {
  if (error instanceof AssignmentError || error instanceof ProviderError) return error.message;
  return error instanceof Error ? error.name : typeof error;
}

function safeRetry(control: Pick<ControlApi, "retry">, assignment: TranscriptionAssignment, context: JourneyContext, errorCode: string, terminal: boolean, logger: DispatcherLogger, retryAt?: string): Promise<void> {
  return reportRetry(logger, "dispatcher", () =>
    control.retry({
      jobId: assignment.jobId,
      attempt: assignment.attempt,
      leaseToken: assignment.leaseToken,
      errorCode,
      terminal,
      ...(retryAt === undefined ? {} : { retryAt }),
      context,
    }),
  );
}

export function createLambdaHandler(dependencies: DispatcherDependencies) {
  return (event: DispatcherEvent, context: DispatcherContext): Promise<RunSummary> => runDispatcher(event, context, dependencies);
}
