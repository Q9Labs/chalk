import { createHash, randomUUID } from "node:crypto";
import { AssignmentError, ControlApiError, providerFailureKind, safeErrorCode } from "./errors.js";
export { mergeTranscriptDocuments } from "./finalizer-merge.js";
import { mergeTranscriptDocuments } from "./finalizer-merge.js";
import type { ChunkDocument } from "./finalizer-merge.js";
import { fetchAudioChunk, conditionalPutJson } from "./storage.js";
import type { DispatcherDependencies } from "./dispatcher.js";
import type { DispatcherContext, DispatcherEvent, DispatcherLogger, FinalizeAssignment, JourneyContext, NormalizedTranscriptDocument } from "./types.js";

export async function runFinalizeDispatcher(event: DispatcherEvent = {}, context: DispatcherContext, dependencies: DispatcherDependencies, maxClaims?: number): Promise<{ claimed: number; completed: number; failed: number }> {
  const claimFinalize = dependencies.control.claimFinalize;
  const completeFinalize = dependencies.control.completeFinalize;
  const retryFinalize = dependencies.control.retryFinalize;
  if (!claimFinalize || !completeFinalize || !retryFinalize) return { claimed: 0, completed: 0, failed: 0 };
  const logger = dependencies.logger ?? { info: () => undefined, warn: () => undefined };
  const now = dependencies.now ?? Date.now;
  const journey: JourneyContext = {
    journeyId: event.journeyId ?? randomUUID(),
    ...(event.traceparent === undefined ? {} : { traceparent: event.traceparent }),
    ...(event.tracestate === undefined ? {} : { tracestate: event.tracestate }),
  };
  const configuredLimit = Math.min(dependencies.config.maxBatch, dependencies.config.concurrency, 50);
  const limit = Math.min(configuredLimit, maxClaims ?? configuredLimit);
  if (limit <= 0 || context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) {
    logger.info("finalize_timeout_reserve_reached");
    return { claimed: 0, completed: 0, failed: 0 };
  }
  const claim = await claimFinalize({ limit, context: journey });
  const assignments = claim.assignments;
  let completed = 0;
  let failed = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, assignments.length) }, async () => {
    while (cursor < assignments.length) {
      const assignment = assignments[cursor];
      cursor += 1;
      if (!assignment) return;
      if (context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) {
        await safeFinalizeRetry(retryFinalize, assignment, journey, "timeout_reserve", false, logger);
        failed += 1;
        continue;
      }
      const result = await processFinalizeAssignment(assignment, journey, context, dependencies, now);
      if (result === "completed") completed += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);
  logger.info("finalize_claimed", { count: assignments.length });
  return { claimed: assignments.length, completed, failed };
}

async function processFinalizeAssignment(assignment: FinalizeAssignment, journey: JourneyContext, context: DispatcherContext, dependencies: DispatcherDependencies, now: () => number): Promise<"completed" | "failed"> {
  const logger = dependencies.logger ?? { info: () => undefined, warn: () => undefined };
  try {
    const documents: ChunkDocument[] = [];
    let totalChunkBytes = 0;
    let lastHeartbeat = now();
    if (dependencies.control.heartbeatFinalize) {
      await dependencies.control.heartbeatFinalize({ assignment, context: journey });
    }
    for (const chunk of assignment.chunks) {
      if (context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) throw new AssignmentError("finalize timeout reserve", true);
      if (dependencies.control.heartbeatFinalize && now() - lastHeartbeat >= 30_000) {
        await dependencies.control.heartbeatFinalize({ assignment, context: journey });
        lastHeartbeat = now();
      }
      const fetched = await fetchAudioChunk({
        fetch: dependencies.fetch,
        url: chunk.inputUrl,
        expectedContentType: chunk.inputContentType,
        expectedSizeBytes: chunk.inputSizeBytes,
        expectedSha256: chunk.inputSha256,
        maxBytes: dependencies.config.provider.maxResponseBytes,
      });
      totalChunkBytes += fetched.bytes.byteLength;
      if (totalChunkBytes > dependencies.config.provider.maxResponseBytes) throw new AssignmentError("finalize input bound exceeded");
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(fetched.bytes)) as unknown;
      } catch {
        throw new AssignmentError("finalize chunk JSON is invalid");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AssignmentError("finalize chunk document is invalid");
      documents.push({ assignment: chunk, document: parsed as NormalizedTranscriptDocument });
    }
    const document = mergeTranscriptDocuments({ jobId: assignment.jobId, ...(assignment.sessionId === undefined ? {} : { sessionId: assignment.sessionId }), attempt: assignment.attempt, chunks: documents, maxTextChars: dependencies.config.provider.maxTextChars });
    const languages = [...new Set(documents.flatMap(({ document: chunkDocument }) => (chunkDocument.language === undefined ? [] : [chunkDocument.language])))].sort();
    const body = new TextEncoder().encode(JSON.stringify(document));
    if (body.byteLength > dependencies.config.provider.maxResponseBytes) throw new AssignmentError("final transcript exceeded bound");
    const checksumSha256 = createHash("sha256").update(body).digest("hex");
    const uploaded = await conditionalPutJson({ fetch: dependencies.fetch, url: assignment.outputPutUrl, body, checksumSha256 });
    if (uploaded === "already_exists") {
      // The control plane verifies the existing object against this checksum,
      // size, and content type before accepting completion. That makes a
      // retry after a successful PUT but transient completion failure safe.
      logger.warn("finalize_existing_result_verified_by_completion");
    }
    await dependencies.control.completeFinalize?.({
      jobId: assignment.jobId,
      attempt: assignment.attempt,
      leaseToken: assignment.leaseToken,
      checksumSha256,
      sizeBytes: body.byteLength,
      contentType: assignment.outputContentType,
      provider: document.provider,
      model: document.model,
      versionContract: document.versionContract,
      languages,
      quality: document.quality,
      context: journey,
    });
    logger.info("finalize_completed", { provider: document.provider, cues: document.cues.length });
    return "completed";
  } catch (error) {
    if (error instanceof ControlApiError && error.status === 409) {
      logger.warn("finalize_late_or_duplicate_completion_rejected");
      return "failed";
    }
    const kind = providerFailureKind(error);
    const terminal = kind === "nonretryable" || kind === "schema";
    await safeFinalizeRetry(dependencies.control.retryFinalize, assignment, journey, safeErrorCode(error), terminal, logger);
    return "failed";
  }
}

async function safeFinalizeRetry(retryFinalize: DispatcherDependencies["control"]["retryFinalize"], assignment: FinalizeAssignment, context: JourneyContext, errorCode: string, terminal: boolean, logger: DispatcherLogger): Promise<void> {
  try {
    if (!retryFinalize) throw new Error("finalize retry API is not configured");
    await retryFinalize({ jobId: assignment.jobId, attempt: assignment.attempt, leaseToken: assignment.leaseToken, errorCode, terminal, context });
  } catch (error) {
    logger.warn("finalize_retry_report_failed", { error: safeErrorCode(error) });
  }
}
