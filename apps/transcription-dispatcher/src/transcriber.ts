import { AssignmentError, ProviderError, isLateCompletion, isTerminalFailure, providerFailureKind, providerSchemaFields, safeErrorCode } from "./errors.js";
import type { TranscriptionAssignment } from "./assignment-types.js";
import { normalizeTranscriptChunk, serializeTranscript } from "./normalize.js";
import { isReasonWord } from "./provider-utils.js";
import { loggerOf, reportRetry } from "./queue.js";
import type { JobQueue } from "./queue.js";
import { InvocationCircuit, transcribeWithFallback } from "./retry.js";
import { validateSpeakerTurnManifest } from "./speaker-turn-manifest.js";
import { fetchVerified, putResult } from "./storage.js";
import type { ProviderResult, TranscriptionProvider } from "./provider-types.js";
import type { CompletionInput, ControlApi, DispatcherContext, DispatcherDependencies, DispatcherLogger, JourneyContext } from "./types.js";

type Manifest = ReturnType<typeof validateSpeakerTurnManifest>;

export function transcriptionQueue(context: DispatcherContext, dependencies: DispatcherDependencies): JobQueue<TranscriptionAssignment> {
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
    const { audio, manifest } = await fetchInputs(assignment, dependencies);
    const transcription = await transcribeWithFallback({
      ...providersFor(assignment, dependencies),
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
      measuredAudioMs: measuredAudioMs(assignment),
      sourceIdentity: assignment.chunk.sourceIdentity,
      sourceTrackClass: assignment.chunk.sourceTrackClass,
    });
    const stored = await putResult({ fetch: dependencies.fetch, url: assignment.outputPutUrl, body: serializeTranscript(document), maxBytes: dependencies.config.provider.maxResponseBytes, tooLarge: "normalized transcript exceeded bound", logger, logPrefix: "dispatcher" });
    await dependencies.control.complete({ ...completionInput(assignment, stored, transcription.result), context: journey });
    logger.info("dispatcher_completed", { provider: transcription.result.provider, fallback: transcription.usedFallback, attempts: transcription.providerAttempts });
    return "completed";
  } catch (error) {
    if (isLateCompletion(error)) {
      logger.warn("dispatcher_late_or_duplicate_completion_rejected");
      return "failed";
    }
    await reportAssignmentFailure(error, assignment, journey, dependencies.control, logger);
    return "failed";
  }
}

function measuredAudioMs(assignment: TranscriptionAssignment): number {
  return assignment.chunk.episodeEndMs - assignment.chunk.episodeStartMs;
}

async function fetchInputs(assignment: TranscriptionAssignment, dependencies: DispatcherDependencies) {
  const { chunk, manifest } = assignment;
  const { provider } = dependencies.config;
  if (measuredAudioMs(assignment) / 1_000 > provider.maxAudioSeconds) throw new AssignmentError("audio duration bound exceeded");
  const audio = await fetchVerified({
    fetch: dependencies.fetch,
    url: chunk.inputUrl,
    expectedContentType: chunk.inputContentType,
    expectedSizeBytes: chunk.inputSizeBytes,
    expectedSha256: chunk.inputSha256,
    maxBytes: provider.maxAudioBytes,
  });
  const manifestBytes = await fetchVerified({
    fetch: dependencies.fetch,
    url: manifest.inputUrl,
    expectedContentType: manifest.contentType,
    expectedSizeBytes: manifest.sizeBytes,
    expectedSha256: manifest.sha256,
    maxBytes: provider.maxResponseBytes,
  });
  return { audio, manifest: parseManifest(manifestBytes.bytes, assignment) };
}

function parseManifest(bytes: Uint8Array, assignment: TranscriptionAssignment): Manifest {
  try {
    return validateSpeakerTurnManifest(JSON.parse(new TextDecoder().decode(bytes)) as unknown, assignment);
  } catch {
    throw new AssignmentError("speaker turn manifest is invalid");
  }
}

/** Auto language uses the code-switching provider alone; a fixed language uses the primary with the fallback behind it. */
function providersFor(assignment: TranscriptionAssignment, dependencies: DispatcherDependencies): { primary?: TranscriptionProvider; fallback?: TranscriptionProvider } {
  const auto = (assignment.transcriptLanguage?.mode ?? "auto") === "auto";
  if (auto && !dependencies.codeswitch) throw new ProviderError("Auto transcription provider is unavailable", "retryable");
  const primary = auto ? dependencies.codeswitch : dependencies.primary;
  return {
    ...(primary ? { primary } : {}),
    ...(!auto && dependencies.fallback ? { fallback: dependencies.fallback } : {}),
  };
}

function completionInput(assignment: TranscriptionAssignment, stored: { checksumSha256: string; sizeBytes: number }, result: ProviderResult): CompletionInput {
  return {
    jobId: assignment.jobId,
    attempt: assignment.attempt,
    leaseToken: assignment.leaseToken,
    checksumSha256: stored.checksumSha256,
    sizeBytes: stored.sizeBytes,
    contentType: assignment.outputContentType,
    provider: result.provider,
    model: result.model,
    versionContract: result.versionContract,
    ...(result.executionIdentity === undefined ? {} : { executionIdentity: result.executionIdentity }),
    ...(result.providerIdentity?.requestId === undefined ? {} : { providerRequestId: result.providerIdentity.requestId }),
    ...(result.language === undefined ? {} : { language: result.language }),
    measuredAudioMs: measuredAudioMs(assignment),
    ...(result.durationMs === undefined ? {} : { providerObservedDurationMs: result.durationMs }),
    ...(result.quality === undefined ? {} : { quality: result.quality }),
  };
}

// The error code is stored only by the control plane, so a terminal failure needs this line to have a reason anywhere else.
export async function reportAssignmentFailure(error: unknown, assignment: TranscriptionAssignment, journey: JourneyContext, control: Pick<ControlApi, "retry">, logger: DispatcherLogger): Promise<void> {
  const terminal = isTerminalFailure(error);
  if (error instanceof ProviderError && error.kind === "schema") logger.warn("provider_schema_invalid", { ...providerSchemaFields(error) });
  const errorCode = safeErrorCode(error);
  logger.warn("dispatcher_assignment_failed", {
    jobId: assignment.jobId,
    journeyId: journey.journeyId,
    errorCode,
    kind: providerFailureKind(error),
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
  return reportRetry(logger, "dispatcher", () => control.retry({ jobId: assignment.jobId, attempt: assignment.attempt, leaseToken: assignment.leaseToken, errorCode, terminal, ...(retryAt === undefined ? {} : { retryAt }), context }));
}
