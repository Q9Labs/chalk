import { ControlApiError, isRetryableStatus } from "./errors.js";
import { validateAssignment, validateCleanupAssignment, validateFinalizeAssignment } from "./assignment.js";
import type { ClaimResponse, CleanupAssignment, FinalizeClaimResponse } from "./assignment-types.js";
import type { CompletionInput, ControlApi, ControlCall, FinalizeCompletionInput, JourneyContext, Lease, RetryInput } from "./types.js";
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

function leaseBody(lease: Lease) {
  return { job_id: lease.jobId, attempt: lease.attempt, lease_token: lease.leaseToken };
}

function retryBody(lease: Lease, input: { errorCode: string; retryAt?: string; terminal?: boolean }) {
  return {
    ...leaseBody(lease),
    error_code: input.errorCode,
    ...(input.retryAt === undefined ? {} : { retry_at: input.retryAt }),
    ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
  };
}

/** The fields every completion carries: the result object and who produced it. */
function resultBody(input: CompletionInput | FinalizeCompletionInput) {
  return {
    ...leaseBody(input),
    result_sha256: input.checksumSha256,
    result_size_bytes: input.sizeBytes,
    content_type: input.contentType,
    provider: input.provider,
    model: input.model,
    version_contract: input.versionContract,
    ...(input.executionIdentity === undefined ? {} : { execution_identity: input.executionIdentity }),
    ...(input.providerRequestId === undefined ? {} : { provider_request_id: input.providerRequestId }),
    ...(input.quality === undefined ? {} : { quality: input.quality }),
  };
}

/** `kind` is "", "finalize " or "cleanup ", and only words the error messages. */
function claimedAssignments(value: unknown, kind: string): unknown[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ControlApiError(`invalid ${kind}claim response`, 502);
  const assignments = "assignments" in value ? value.assignments : undefined;
  if (!Array.isArray(assignments)) throw new ControlApiError(`invalid ${kind}assignments`, 502);
  return assignments;
}

export class RecorderControlApiClient implements ControlApi {
  private readonly options: ControlApiOptions;

  constructor(options: ControlApiOptions) {
    this.options = options;
  }

  async claim(input: { limit: number } & ControlCall): Promise<ClaimResponse> {
    return { assignments: (await this.claimAssignments("/internal/v1/transcription/jobs/claim", "", input)).map(validateAssignment) };
  }

  async claimFinalize(input: { limit: number } & ControlCall): Promise<FinalizeClaimResponse> {
    return { assignments: (await this.claimAssignments("/internal/v1/transcription/finalize/claim", "finalize ", input)).map(validateFinalizeAssignment) };
  }

  async claimCleanup(input: { limit: number } & ControlCall): Promise<{ assignments: CleanupAssignment[] }> {
    return { assignments: (await this.claimAssignments("/internal/v1/transcription/cleanup/claim", "cleanup ", input)).map(validateCleanupAssignment) };
  }

  async heartbeat(input: { assignment: Lease } & ControlCall): Promise<void> {
    await this.call("/internal/v1/transcription/jobs/heartbeat", leaseBody(input.assignment), input);
  }

  async retry(input: RetryInput & ControlCall): Promise<void> {
    await this.call("/internal/v1/transcription/jobs/retry", retryBody(input, input), input);
  }

  async retryFinalize(input: RetryInput & ControlCall): Promise<void> {
    await this.call("/internal/v1/transcription/finalize/retry", retryBody(input, input), input);
  }

  async retryCleanup(input: { assignment: CleanupAssignment; errorCode: string; terminal?: boolean } & ControlCall): Promise<void> {
    await this.call("/internal/v1/transcription/cleanup/retry", retryBody(input.assignment, input), input);
  }

  async complete(input: CompletionInput & ControlCall): Promise<void> {
    const body = {
      ...resultBody(input),
      ...(input.language === undefined ? {} : { language: input.language }),
      measured_audio_ms: input.measuredAudioMs,
      ...(input.providerObservedDurationMs === undefined ? {} : { provider_observed_duration_ms: input.providerObservedDurationMs }),
      ...(input.billedAudioSeconds === undefined ? {} : { billed_audio_seconds: input.billedAudioSeconds }),
    };
    await this.call("/internal/v1/transcription/jobs/complete", body, input);
  }

  async completeFinalize(input: FinalizeCompletionInput & ControlCall): Promise<void> {
    await this.call("/internal/v1/transcription/finalize/complete", { ...resultBody(input), languages: input.languages }, input);
  }

  async completeCleanup(input: { assignment: CleanupAssignment } & ControlCall): Promise<void> {
    await this.call("/internal/v1/transcription/cleanup/complete", leaseBody(input.assignment), input);
  }

  private async claimAssignments(path: string, kind: string, input: { limit: number } & ControlCall): Promise<unknown[]> {
    return claimedAssignments(await this.call(path, { batch_size: input.limit }, input), kind);
  }

  private async call(path: string, body: unknown, { context, signal }: ControlCall): Promise<unknown> {
    const method = "POST";
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
      throw new ControlApiError(`control API request failed: ${method} ${path} returned ${response.status}`, response.status, isRetryableStatus(response.status));
    }
    return parseResponse(response);
  }
}

function networkCauseCode(error: TypeError): string {
  const cause: unknown = error.cause;
  if (cause instanceof Error && "code" in cause && typeof cause.code === "string") return cause.code;
  return "unknown";
}
