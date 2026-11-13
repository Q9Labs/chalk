import { ControlApiError } from "./errors.js";
import { validateAssignment, validateCleanupAssignment, validateFinalizeAssignment } from "./assignment.js";
import type { ClaimResponse, CleanupAssignment, CompletionInput, ControlApi, FinalizeAssignment, FinalizeCompletionInput, FinalizeClaimResponse, JourneyContext, RetryInput, TranscriptionAssignment } from "./types.js";
import type { WorkloadSigner } from "./workload-auth.js";

interface ControlApiOptions {
  baseUrl: string;
  signer: WorkloadSigner;
  fetch: typeof fetch;
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
    const validated = assignments.map((assignment) => validateAssignment(assignment));
    return { assignments: validated };
  }

  async heartbeat(input: { assignment: Pick<TranscriptionAssignment, "jobId" | "attempt" | "leaseToken">; context: JourneyContext; signal?: AbortSignal }): Promise<void> {
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
    const validated = assignments.map((assignment) => validateFinalizeAssignment(assignment));
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

  async claimCleanup(input: { limit: number; context: JourneyContext; signal?: AbortSignal }): Promise<{ assignments: CleanupAssignment[] }> {
    const value = await this.call("/internal/v1/transcription/cleanup/claim", "POST", { batch_size: input.limit }, input.context, input.signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlApiError("invalid cleanup claim response", 502);
    const assignments = (value as Record<string, unknown>).assignments;
    if (!Array.isArray(assignments)) throw new ControlApiError("invalid cleanup assignments", 502);
    return { assignments: assignments.map((assignment) => validateCleanupAssignment(assignment)) };
  }

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
    let response: Response;
    try {
      response = await this.options.fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", ...contextHeaders(context), ...this.options.signer.sign({ method, path, body: JSON.stringify(body), context }) },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new TypeError(`fetch failed: ${method} ${path} (${networkCauseCode(error)})`, { cause: error });
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ControlApiError(`control API request failed: ${method} ${path} returned ${response.status}`, response.status, retryable);
    }
    return parseResponse(response);
  }
}

function networkCauseCode(error: TypeError): string {
  const cause: unknown = error.cause;
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string") return cause.code;
  return "unknown";
}
