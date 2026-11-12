import { createHash } from "node:crypto";
import { AssignmentError, ControlApiError, isTerminalFailure, safeErrorCode } from "./errors.js";
import { mergeTranscriptDocuments } from "./finalizer-merge.js";
import type { ChunkDocument } from "./finalizer-merge.js";
import { loggerOf, reportRetry } from "./queue.js";
import type { JobQueue } from "./queue.js";
import { fetchVerified, conditionalPutJson } from "./storage.js";
import type { DispatcherContext, DispatcherDependencies, FinalizeAssignment, JourneyContext, NormalizedTranscriptDocument } from "./types.js";

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
    const documents: ChunkDocument[] = [];
    let totalChunkBytes = 0;
    let lastHeartbeat = now();
    await dependencies.control.heartbeat({ assignment, context: journey });
    for (const chunk of assignment.chunks) {
      if (context.getRemainingTimeInMillis() <= dependencies.config.timeoutReserveMs) throw new AssignmentError("finalize timeout reserve", true);
      if (now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        await dependencies.control.heartbeat({ assignment, context: journey });
        lastHeartbeat = now();
      }
      const fetched = await fetchVerified({
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
    const document = mergeTranscriptDocuments({ jobId: assignment.jobId, episodeId: assignment.episodeId, attempt: assignment.attempt, chunks: documents, maxTextChars: dependencies.config.provider.maxTextChars });
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
    await dependencies.control.completeFinalize({
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

function retryFinalize(dependencies: DispatcherDependencies, assignment: FinalizeAssignment, context: JourneyContext, errorCode: string, terminal: boolean): Promise<void> {
  return reportRetry(loggerOf(dependencies), "finalize", () => dependencies.control.retryFinalize({ jobId: assignment.jobId, attempt: assignment.attempt, leaseToken: assignment.leaseToken, errorCode, terminal, context }));
}
