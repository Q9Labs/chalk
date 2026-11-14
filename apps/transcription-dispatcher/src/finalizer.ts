import { AssignmentError, isLateCompletion, isTerminalFailure, safeErrorCode } from "./errors.js";
import { mergeTranscriptDocuments } from "./finalizer-merge.js";
import type { ChunkDocument } from "./finalizer-merge.js";
import { serializeTranscript } from "./normalize.js";
import { loggerOf, reportRetry } from "./queue.js";
import type { JobQueue } from "./queue.js";
import { fetchVerified, putResult } from "./storage.js";
import type { FinalizeAssignment } from "./assignment-types.js";
import type { NormalizedTranscriptDocument } from "./transcript-types.js";
import type { DispatcherContext, DispatcherDependencies, JourneyContext } from "./types.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export function finalizeQueue(context: DispatcherContext, dependencies: DispatcherDependencies): JobQueue<FinalizeAssignment> {
  const now = dependencies.now ?? Date.now;
  return {
    logPrefix: "finalize",
    claim: async (limit, journey) => (await dependencies.control.claimFinalize({ limit, context: journey })).assignments,
    process: (assignment, journey) => processFinalizeAssignment(assignment, journey, context, dependencies, now),
    release: (assignment, journey) => retryFinalize(dependencies, assignment, journey, "timeout_reserve", false),
  };
}

async function processFinalizeAssignment(assignment: FinalizeAssignment, journey: JourneyContext, context: DispatcherContext, dependencies: DispatcherDependencies, now: () => number): Promise<"completed" | "failed"> {
  const logger = loggerOf(dependencies);
  try {
    const chunks = await fetchChunkDocuments(assignment, journey, context, dependencies, now);
    const document = mergeTranscriptDocuments({ jobId: assignment.jobId, episodeId: assignment.episodeId, attempt: assignment.attempt, chunks, maxTextChars: dependencies.config.provider.maxTextChars });
    const stored = await putResult({ fetch: dependencies.fetch, url: assignment.outputPutUrl, body: serializeTranscript(document), maxBytes: dependencies.config.provider.maxResponseBytes, tooLarge: "final transcript exceeded bound", logger, logPrefix: "finalize" });
    await dependencies.control.completeFinalize({
      jobId: assignment.jobId,
      attempt: assignment.attempt,
      leaseToken: assignment.leaseToken,
      checksumSha256: stored.checksumSha256,
      sizeBytes: stored.sizeBytes,
      contentType: assignment.outputContentType,
      provider: document.provider,
      model: document.model,
      versionContract: document.versionContract,
      languages: [...new Set(chunks.flatMap((chunk) => chunk.document.language ?? []))].sort(),
      quality: document.quality,
      context: journey,
    });
    logger.info("finalize_completed", { provider: document.provider, cues: document.cues.length });
    return "completed";
  } catch (error) {
    if (isLateCompletion(error)) {
      logger.warn("finalize_failed", { error: safeErrorCode(error), attempt: assignment.attempt, terminal: false });
      logger.warn("finalize_late_or_duplicate_completion_rejected");
      return "failed";
    }
    const terminal = isTerminalFailure(error);
    const errorCode = safeErrorCode(error);
    logger.warn("finalize_failed", { error: errorCode, attempt: assignment.attempt, terminal });
    await retryFinalize(dependencies, assignment, journey, errorCode, terminal);
    return "failed";
  }
}

/** Download every chunk result, keeping the lease alive and the total size bounded. */
async function fetchChunkDocuments(assignment: FinalizeAssignment, journey: JourneyContext, context: DispatcherContext, dependencies: DispatcherDependencies, now: () => number): Promise<ChunkDocument[]> {
  const { maxResponseBytes } = dependencies.config.provider;
  const heartbeat = () => dependencies.control.heartbeat({ assignment, context: journey });
  const documents: ChunkDocument[] = [];
  let totalBytes = 0;
  let lastHeartbeat = now();
  await heartbeat();
  for (const chunk of assignment.chunks) {
    if (context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) throw new AssignmentError("finalize timeout reserve", true);
    if (now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      await heartbeat();
      lastHeartbeat = now();
    }
    const fetched = await fetchVerified({
      fetch: dependencies.fetch,
      url: chunk.inputUrl,
      expectedContentType: chunk.inputContentType,
      expectedSizeBytes: chunk.inputSizeBytes,
      expectedSha256: chunk.inputSha256,
      maxBytes: maxResponseBytes,
    });
    totalBytes += fetched.bytes.byteLength;
    if (totalBytes > maxResponseBytes) throw new AssignmentError("finalize input bound exceeded");
    documents.push({ assignment: chunk, document: parseChunkDocument(fetched.bytes) });
  }
  return documents;
}

function parseChunkDocument(bytes: Uint8Array): NormalizedTranscriptDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new AssignmentError("finalize chunk JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AssignmentError("finalize chunk document is invalid");
  return parsed as NormalizedTranscriptDocument;
}

function retryFinalize(dependencies: DispatcherDependencies, assignment: FinalizeAssignment, context: JourneyContext, errorCode: string, terminal: boolean): Promise<void> {
  return reportRetry(loggerOf(dependencies), "finalize", () => dependencies.control.retryFinalize({ jobId: assignment.jobId, attempt: assignment.attempt, leaseToken: assignment.leaseToken, errorCode, terminal, context }));
}
