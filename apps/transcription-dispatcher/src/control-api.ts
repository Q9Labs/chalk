import { ControlApiError } from "./errors.js";
import { validateAssignment, validateCleanupAssignment, validateFinalizeAssignment } from "./urls.js";
import type { ClaimResponse, CleanupAssignment, CompletionInput, ControlApi, FinalizeAssignment, FinalizeCompletionInput, FinalizeClaimResponse, JourneyContext, RetryInput, TranscriptionAssignment } from "./types.js";
import type { WorkloadSigner } from "./workload-auth.js";

interface ControlApiOptions {
  baseUrl: string;
  signer: WorkloadSigner;
  fetch: typeof fetch;
  maxAssignmentUrlTtlMs?: number;
  maxFinalizeChunks?: number;
}

function contextHeaders(context: JourneyContext): Record<string, string> {
  return {
    "x-chalk-journey-id": context.journeyId,
    ...(context.traceparent === undefined ? {} : { traceparent: context.traceparent }),
    ...(context.tracestate === undefined ? {} : { tracestate: context.tracestate }),
  };
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

export class RecorderControlApiClient implements ControlApi {
  private readonly options: ControlApiOptions;

  constructor(options: ControlApiOptions) {
    this.options = options;
  }

  async claim(input: { limit: number; context: JourneyContext; signal?: AbortSignal }): Promise<ClaimResponse> {
    const value = await this.call("/internal/v1/transcription/jobs/claim", "POST", { batch_size: input.limit }, input.context, input.signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlApiError("invalid claim response", 502);
    const assignments = (value as Record<string, unknown>).assignments;
    if (!Array.isArray(assignments)) throw new ControlApiError("invalid claim assignments", 502);
    const validated = assignments.map((assignment) => validateAssignment(canonicalAssignment(assignment), this.options.maxAssignmentUrlTtlMs));
    return { assignments: validated };
  }

  // fallow-ignore-next-line unused-class-member
  async heartbeat(input: { assignment: TranscriptionAssignment; context: JourneyContext; signal?: AbortSignal }): Promise<void> {
    await this.call(
      "/internal/v1/transcription/jobs/heartbeat",
      "POST",
      {
        job_id: input.assignment.jobId,
        attempt: input.assignment.attempt,
        lease_token: input.assignment.leaseToken,
      },
      input.context,
      input.signal,
    );
  }

  // fallow-ignore-next-line unused-class-member
  async heartbeatFinalize(input: { assignment: FinalizeAssignment; context: JourneyContext; signal?: AbortSignal }): Promise<void> {
    await this.call(
      "/internal/v1/transcription/jobs/heartbeat",
      "POST",
      {
        job_id: input.assignment.jobId,
        attempt: input.assignment.attempt,
        lease_token: input.assignment.leaseToken,
      },
      input.context,
      input.signal,
    );
  }

  async retry(input: RetryInput & { context: JourneyContext; signal?: AbortSignal }): Promise<void> {
    await this.call(
      "/internal/v1/transcription/jobs/retry",
      "POST",
      {
        job_id: input.jobId,
        attempt: input.attempt,
        lease_token: input.leaseToken,
        error_code: input.errorCode,
        ...(input.retryAt === undefined ? {} : { retry_at: input.retryAt }),
        ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
      },
      input.context,
      input.signal,
    );
  }

  // fallow-ignore-next-line unused-class-member
  async complete(input: CompletionInput & { context: JourneyContext; signal?: AbortSignal }): Promise<void> {
    await this.call(
      "/internal/v1/transcription/jobs/complete",
      "POST",
      {
        job_id: input.jobId,
        attempt: input.attempt,
        lease_token: input.leaseToken,
        result_sha256: input.checksumSha256,
        result_size_bytes: input.sizeBytes,
        content_type: input.contentType,
        provider: input.provider,
        model: input.model,
        version_contract: input.versionContract,
        ...(input.executionIdentity === undefined ? {} : { execution_identity: input.executionIdentity }),
        ...(input.providerRequestId === undefined ? {} : { provider_request_id: input.providerRequestId }),
        ...(input.language === undefined ? {} : { language: input.language }),
        measured_audio_ms: input.measuredAudioMs,
        ...(input.providerObservedDurationMs === undefined ? {} : { provider_observed_duration_ms: input.providerObservedDurationMs }),
        ...(input.billedAudioSeconds === undefined ? {} : { billed_audio_seconds: input.billedAudioSeconds }),
        ...(input.quality === undefined ? {} : { quality: input.quality }),
      },
      input.context,
      input.signal,
    );
  }

  async claimFinalize(input: { limit: number; context: JourneyContext; signal?: AbortSignal }): Promise<FinalizeClaimResponse> {
    const value = await this.call("/internal/v1/transcription/finalize/claim", "POST", { batch_size: input.limit }, input.context, input.signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlApiError("invalid finalize claim response", 502);
    const assignments = (value as Record<string, unknown>).assignments;
    if (!Array.isArray(assignments)) throw new ControlApiError("invalid finalize assignments", 502);
    const validated = assignments.map((assignment) => validateFinalizeAssignment(canonicalFinalizeAssignment(assignment), this.options.maxAssignmentUrlTtlMs, this.options.maxFinalizeChunks ?? 50));
    return { assignments: validated };
  }

  async completeFinalize(input: FinalizeCompletionInput & { context: JourneyContext; signal?: AbortSignal }): Promise<void> {
    await this.call(
      "/internal/v1/transcription/finalize/complete",
      "POST",
      {
        job_id: input.jobId,
        attempt: input.attempt,
        lease_token: input.leaseToken,
        result_sha256: input.checksumSha256,
        result_size_bytes: input.sizeBytes,
        content_type: input.contentType,
        provider: input.provider,
        model: input.model,
        version_contract: input.versionContract,
        languages: input.languages,
        ...(input.executionIdentity === undefined ? {} : { execution_identity: input.executionIdentity }),
        ...(input.providerRequestId === undefined ? {} : { provider_request_id: input.providerRequestId }),
        ...(input.quality === undefined ? {} : { quality: input.quality }),
      },
      input.context,
      input.signal,
    );
  }

  async retryFinalize(input: { jobId: string; attempt: number; leaseToken: string; errorCode: string; retryAt?: string; terminal?: boolean; context: JourneyContext; signal?: AbortSignal }): Promise<void> {
    await this.call(
      "/internal/v1/transcription/finalize/retry",
      "POST",
      {
        job_id: input.jobId,
        attempt: input.attempt,
        lease_token: input.leaseToken,
        error_code: input.errorCode,
        ...(input.retryAt === undefined ? {} : { retry_at: input.retryAt }),
        ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
      },
      input.context,
      input.signal,
    );
  }

  // fallow-ignore-next-line unused-class-member
  async claimCleanup(input: { limit: number; context: JourneyContext; signal?: AbortSignal }): Promise<{ assignments: CleanupAssignment[] }> {
    const value = await this.call("/internal/v1/transcription/cleanup/claim", "POST", { batch_size: input.limit }, input.context, input.signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlApiError("invalid cleanup claim response", 502);
    const assignments = (value as Record<string, unknown>).assignments;
    if (!Array.isArray(assignments)) throw new ControlApiError("invalid cleanup assignments", 502);
    return { assignments: assignments.map((assignment) => validateCleanupAssignment(assignment, this.options.maxAssignmentUrlTtlMs)) };
  }

  // fallow-ignore-next-line unused-class-member
  async completeCleanup(input: { assignment: CleanupAssignment; context: JourneyContext; signal?: AbortSignal }): Promise<void> {
    await this.call(
      "/internal/v1/transcription/cleanup/complete",
      "POST",
      {
        job_id: input.assignment.jobId,
        attempt: input.assignment.attempt,
        lease_token: input.assignment.leaseToken,
      },
      input.context,
      input.signal,
    );
  }

  // fallow-ignore-next-line unused-class-member
  async retryCleanup(input: { assignment: CleanupAssignment; errorCode: string; terminal?: boolean; context: JourneyContext; signal?: AbortSignal }): Promise<void> {
    await this.call(
      "/internal/v1/transcription/cleanup/retry",
      "POST",
      {
        job_id: input.assignment.jobId,
        attempt: input.assignment.attempt,
        lease_token: input.assignment.leaseToken,
        error_code: input.errorCode,
        ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
      },
      input.context,
      input.signal,
    );
  }

  private async call(path: string, method: "POST", body: unknown, context: JourneyContext, signal?: AbortSignal): Promise<unknown> {
    const response = await this.options.fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...contextHeaders(context), ...this.options.signer.sign({ method, path, body: JSON.stringify(body), context }) },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ControlApiError("control API request failed", response.status, retryable);
    }
    return parseResponse(response);
  }
}

function canonicalAssignment(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const assignment = value as Record<string, unknown>;
  const chunkValue = assignment.chunk ?? assignment.audio_chunk;
  const chunk = chunkValue && typeof chunkValue === "object" && !Array.isArray(chunkValue) ? (chunkValue as Record<string, unknown>) : chunkValue;
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return value;
  const source = chunk as Record<string, unknown>;
  return {
    ...assignment,
    sessionId: assignment.sessionId ?? assignment.session_id,
    leaseToken: assignment.leaseToken ?? assignment.lease_token,
    leaseExpiresAt: assignment.leaseExpiresAt ?? assignment.lease_expires_at,
    outputPutUrl: assignment.outputPutUrl ?? assignment.output_put_url ?? assignment.result_put_url,
    outputPutUrlExpiresAt: assignment.outputPutUrlExpiresAt ?? assignment.output_put_url_expires_at ?? assignment.result_put_url_expires_at,
    outputContentType: assignment.outputContentType ?? assignment.output_content_type,
    manifest: assignment.manifest ?? assignment.speaker_turn_manifest ?? assignment.manifest_authority,
    chunk: {
      ...source,
      chunkId: source.chunkId ?? source.chunk_id,
      inputUrl: source.inputUrl ?? source.input_url,
      inputUrlExpiresAt: source.inputUrlExpiresAt ?? source.input_url_expires_at,
      inputContentType: source.inputContentType ?? source.input_content_type,
      inputSizeBytes: source.inputSizeBytes ?? source.input_size_bytes,
      inputSha256: source.inputSha256 ?? source.input_sha256,
      meetingStartMs: source.meetingStartMs ?? source.meeting_start_ms,
      meetingEndMs: source.meetingEndMs ?? source.meeting_end_ms,
      sourceIdentity: source.sourceIdentity ?? source.source_identity,
      sourceTrackClass: source.sourceTrackClass ?? source.source_track_class,
    },
  };
}

function canonicalFinalizeAssignment(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const assignment = value as Record<string, unknown>;
  const chunks = assignment.chunks ?? assignment.chunk_results ?? assignment.results;
  if (!Array.isArray(chunks)) return value;
  return {
    ...assignment,
    jobId: assignment.jobId ?? assignment.job_id,
    transcriptId: assignment.transcriptId ?? assignment.transcript_id,
    sessionId: assignment.sessionId ?? assignment.session_id,
    leaseToken: assignment.leaseToken ?? assignment.lease_token,
    leaseExpiresAt: assignment.leaseExpiresAt ?? assignment.lease_expires_at,
    outputPutUrl: assignment.outputPutUrl ?? assignment.output_put_url ?? assignment.finalPutUrl ?? assignment.final_put_url,
    outputPutUrlExpiresAt: assignment.outputPutUrlExpiresAt ?? assignment.output_put_url_expires_at ?? assignment.finalPutUrlExpiresAt ?? assignment.final_put_url_expires_at,
    outputContentType: assignment.outputContentType ?? assignment.output_content_type,
    chunks: chunks.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const chunk = value as Record<string, unknown>;
      return {
        ...chunk,
        chunkId: chunk.chunkId ?? chunk.chunk_id,
        inputUrl: chunk.inputUrl ?? chunk.input_url ?? chunk.resultUrl ?? chunk.result_url ?? chunk.resultGetUrl ?? chunk.result_get_url,
        inputUrlExpiresAt: chunk.inputUrlExpiresAt ?? chunk.input_url_expires_at,
        inputContentType: chunk.inputContentType ?? chunk.input_content_type,
        inputSizeBytes: chunk.inputSizeBytes ?? chunk.input_size_bytes ?? chunk.resultSizeBytes ?? chunk.result_size_bytes,
        inputSha256: chunk.inputSha256 ?? chunk.input_sha256 ?? chunk.resultSha256 ?? chunk.result_sha256,
        meetingStartMs: chunk.meetingStartMs ?? chunk.meeting_start_ms,
        meetingEndMs: chunk.meetingEndMs ?? chunk.meeting_end_ms,
      };
    }),
  };
}
