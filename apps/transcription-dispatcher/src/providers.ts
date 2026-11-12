import { ProviderError, providerSchemaError } from "./errors.js";
import { CLOUDFLARE_MODEL, DEEPINFRA_MODEL } from "./models.js";
import { classifyProviderStatus, ensureAbortableTimeout, errorCodeFromBody } from "./provider-failure.js";
import { parseJson, parseProviderResponse, parseProviderResult, readProviderBody, valueAt, type ParseLimits } from "./provider-response.js";
import type { ProviderPolicy, ProviderRequest, ProviderResult, TranscriptionProvider } from "./provider-types.js";
import { nativeDeepInfraBody, observedDeepInfraCost, observedDeepInfraIdentity, observedDeepInfraVersion } from "./deepinfra-response.js";

interface DeepInfraOptions {
  fetch: typeof fetch;
  token: string;
  executionIdentityPin?: string;
  modelVersionPin?: string;
  policy: ProviderPolicy;
  versionContract?: string;
  endpoint?: string;
}

interface CloudflareOptions {
  fetch: typeof fetch;
  token: string;
  accountId: string;
  policy: ProviderPolicy;
  adapterContractVersion: string;
  modelSlug?: typeof CLOUDFLARE_MODEL;
  endpoint?: string;
}

function requestIdentity(row: ProviderResult, expectedModel: string): void {
  if (row.providerIdentity?.model && row.providerIdentity.model !== expectedModel) {
    throw providerSchemaError("provider model identity mismatched release", "model", "matching model string", row.providerIdentity?.model);
  }
}

function checkAudio(request: ProviderRequest, policy: ProviderPolicy): void {
  if (request.audio.byteLength === 0 || request.audio.byteLength > policy.maxAudioBytes) throw providerSchemaError("audio exceeded provider bound", "request.audio", "nonempty bounded bytes", request.audio);
  if (!request.contentType.startsWith("audio/")) throw providerSchemaError("audio content type is invalid", "request.contentType", "audio content type string", request.contentType);
}

function parseLimits(policy: ProviderPolicy, request: ProviderRequest): ParseLimits {
  return {
    maxTextChars: policy.maxTextChars,
    maxSegments: policy.maxSegments,
    maxWords: policy.maxWords,
    maxAudioSeconds: policy.maxAudioSeconds,
    ...(request.onTimingRepair === undefined ? {} : { onTimingRepair: request.onTimingRepair }),
  };
}

/** Posts one request and returns a successful response; every other outcome becomes a classified ProviderError. */
async function send(provider: "deepinfra" | "cloudflare", fetcher: typeof fetch, policy: ProviderPolicy, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) throw new ProviderError("provider request timed out", "timeout");
    throw new ProviderError("provider network request failed", "retryable");
  }
  if (!response.ok) throw await parseError(response, policy, provider);
  return response;
}

async function parseError(response: Response, policy: ProviderPolicy, provider: "deepinfra" | "cloudflare"): Promise<ProviderError> {
  let code: string | undefined;
  try {
    code = errorCodeFromBody(parseJson(await readProviderBody(response, Math.min(policy.maxResponseBytes, 64 * 1024))));
  } catch {
    // The bounded body is diagnostic only; status is the authoritative class.
  }
  const kind = classifyProviderStatus(response.status, provider, code);
  return new ProviderError("provider request failed", kind, { status: response.status, ...(code === undefined ? {} : { providerCode: code }) });
}

export class DeepInfraWhisperProvider implements TranscriptionProvider {
  readonly name = "deepinfra" as const;
  private readonly options: DeepInfraOptions;

  constructor(options: DeepInfraOptions) {
    this.options = options;
  }

  async transcribe(request: ProviderRequest): Promise<ProviderResult> {
    const { policy } = this.options;
    checkAudio(request, policy);
    const form = new FormData();
    if (request.transcriptLanguage?.mode === "fixed") form.append("language", request.transcriptLanguage.language);
    form.append("audio", new Blob([Uint8Array.from(request.audio).buffer], { type: request.contentType }), "chunk.audio");
    const response = await send("deepinfra", this.options.fetch, policy, this.options.endpoint ?? `https://api.deepinfra.com/v1/inference/${DEEPINFRA_MODEL}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}` },
      body: form,
      signal: ensureAbortableTimeout(policy.timeoutMs, request.signal),
      redirect: "error",
    });
    return parseProviderResponse(response, policy.maxResponseBytes, (body) => this.result(response, body, request));
  }

  private result(response: Response, body: unknown, request: ProviderRequest): ProviderResult {
    const { policy, executionIdentityPin, modelVersionPin } = this.options;
    const result = parseProviderResult(nativeDeepInfraBody(body, policy.maxTextChars), {
      provider: "deepinfra",
      model: DEEPINFRA_MODEL,
      versionContract: this.options.versionContract ?? "deepinfra-native-whisper-turbo.v1",
      ...parseLimits(policy, request),
    });
    requestIdentity(result, DEEPINFRA_MODEL);
    const observedIdentity = observedDeepInfraIdentity(response, body);
    if (executionIdentityPin && observedIdentity !== executionIdentityPin) {
      throw providerSchemaError("provider execution identity mismatched release", "execution_identity", "matching execution identity string", observedIdentity);
    }
    const observedVersion = observedDeepInfraVersion(response, body);
    const reportedCost = observedDeepInfraCost(body);
    if (modelVersionPin && observedVersion !== modelVersionPin) {
      throw providerSchemaError("provider model version mismatched release", "model_version", "matching model version string", observedVersion);
    }
    return {
      ...result,
      ...(reportedCost === undefined ? {} : { providerReportedCostUsd: reportedCost }),
      ...(observedIdentity === undefined ? {} : { executionIdentity: observedIdentity }),
      ...(observedVersion === undefined ? {} : { providerIdentity: { ...result.providerIdentity, modelVersion: observedVersion } }),
    };
  }
}

export class CloudflareWhisperProvider implements TranscriptionProvider {
  readonly name = "cloudflare" as const;
  private readonly options: CloudflareOptions;

  constructor(options: CloudflareOptions) {
    this.options = options;
  }

  async transcribe(request: ProviderRequest): Promise<ProviderResult> {
    const { policy } = this.options;
    checkAudio(request, policy);
    const modelSlug = this.options.modelSlug ?? CLOUDFLARE_MODEL;
    const endpoint = this.options.endpoint ?? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/ai/run/${modelSlug}`;
    const response = await send("cloudflare", this.options.fetch, policy, endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ audio: Buffer.from(request.audio).toString("base64"), ...(request.transcriptLanguage?.mode === "fixed" ? { language: request.transcriptLanguage.language } : {}) }),
      signal: ensureAbortableTimeout(policy.timeoutMs, request.signal),
    });
    return parseProviderResponse(response, policy.maxResponseBytes, (body) => this.result(body, request));
  }

  private result(body: unknown, request: ProviderRequest): ProviderResult {
    const result = parseProviderResult(valueAt(body, "result") ?? body, {
      provider: "cloudflare",
      model: CLOUDFLARE_MODEL,
      versionContract: this.options.adapterContractVersion,
      ...parseLimits(this.options.policy, request),
    });
    requestIdentity(result, CLOUDFLARE_MODEL);
    const envelope = envelopeIdentity(body);
    return Object.keys(envelope).length === 0 ? result : { ...result, providerIdentity: { ...result.providerIdentity, ...envelope } };
  }
}

/** Cloudflare may repeat the request ID and model outside `result`; they must be strings and match the release. */
function envelopeIdentity(body: unknown): { requestId?: string; model?: string } {
  const snakeRequestId = valueAt(body, "request_id");
  const requestId = snakeRequestId ?? valueAt(body, "requestId");
  if (requestId !== undefined && typeof requestId !== "string") throw providerSchemaError("provider request identity is invalid", snakeRequestId !== undefined ? "request_id" : "requestId", "string", requestId);
  const model = valueAt(body, "model");
  if (model !== undefined && typeof model !== "string") throw providerSchemaError("provider model identity is invalid", "model", "string", model);
  if (model !== undefined && model !== CLOUDFLARE_MODEL) throw providerSchemaError("provider model identity mismatched release", "model", "matching model string", model);
  return { ...(requestId === undefined ? {} : { requestId }), ...(model === undefined ? {} : { model }) };
}
