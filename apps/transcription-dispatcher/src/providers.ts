import { ProviderError } from "./errors.js";
import { classifyProviderStatus, ensureAbortableTimeout, errorCodeFromBody, parseJson, parseProviderResult, readBoundedBody } from "./provider-utils.js";
import type { ProviderPolicy, ProviderRequest, ProviderResult, TranscriptionProvider } from "./types.js";

const DEEPINFRA_MODEL = "openai/whisper-large-v3-turbo" as const;
const CLOUDFLARE_MODEL = "@cf/openai/whisper-large-v3-turbo" as const;

interface DeepInfraOptions {
  fetch: typeof fetch;
  token: string;
  executionIdentityPin: string;
  modelVersionPin: string;
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
    throw new ProviderError("provider model identity mismatched release", "schema");
  }
}

function deepInfraExecutionIdentity(response: Response, body: unknown): string {
  const bodyIdentity = body && typeof body === "object" && !Array.isArray(body) ? ((body as Record<string, unknown>).execution_identity ?? (body as Record<string, unknown>).executionIdentity) : undefined;
  if (bodyIdentity !== undefined && typeof bodyIdentity !== "string") throw new ProviderError("DeepInfra execution identity was invalid", "schema");
  const identity = response.headers.get("x-deepinfra-execution-identity") ?? response.headers.get("x-execution-identity") ?? (bodyIdentity as string | undefined);
  if (!identity) throw new ProviderError("DeepInfra execution identity was not observable", "schema");
  return identity;
}

function deepInfraModelVersion(response: Response, body: unknown): string {
  const bodyVersion = body && typeof body === "object" && !Array.isArray(body) ? ((body as Record<string, unknown>).model_version ?? (body as Record<string, unknown>).modelVersion) : undefined;
  if (bodyVersion !== undefined && typeof bodyVersion !== "string") throw new ProviderError("DeepInfra model version was invalid", "schema");
  const version = response.headers.get("x-deepinfra-model-version") ?? (bodyVersion as string | undefined);
  if (!version) throw new ProviderError("DeepInfra model version was not observable", "schema");
  return version;
}

async function parseError(response: Response, policy: ProviderPolicy, provider: "deepinfra" | "cloudflare"): Promise<ProviderError> {
  let code: string | undefined;
  try {
    code = errorCodeFromBody(parseJson(await readBoundedBody(response, Math.min(policy.maxResponseBytes, 64 * 1024))));
  } catch {
    // The bounded body is diagnostic only; status is the authoritative class.
  }
  const kind = classifyProviderStatus(response.status, provider, code);
  return new ProviderError("provider request failed", kind, { status: response.status, ...(code === undefined ? {} : { providerCode: code }) });
}

export class DeepInfraWhisperProvider implements TranscriptionProvider {
  // fallow-ignore-next-line unused-class-member
  readonly name = "deepinfra" as const;
  private readonly options: DeepInfraOptions;

  constructor(options: DeepInfraOptions) {
    this.options = options;
  }

  async transcribe(request: ProviderRequest): Promise<ProviderResult> {
    if (request.audio.byteLength === 0 || request.audio.byteLength > this.options.policy.maxAudioBytes) throw new ProviderError("audio exceeded provider bound", "schema");
    if (!request.contentType.startsWith("audio/")) throw new ProviderError("audio content type is invalid", "schema");
    const signal = ensureAbortableTimeout(this.options.policy.timeoutMs, request.signal);
    const form = new FormData();
    const audioCopy = Uint8Array.from(request.audio);
    form.append("file", new Blob([audioCopy.buffer], { type: request.contentType }), "chunk.mp3");
    form.append("model", DEEPINFRA_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities", "segment");
    form.append("timestamp_granularities", "word");
    let response: Response;
    try {
      response = await this.options.fetch(this.options.endpoint ?? "https://api.deepinfra.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.token}` },
        body: form,
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new ProviderError("provider request timed out", "timeout");
      throw new ProviderError("provider network request failed", "retryable");
    }
    if (!response.ok) throw await parseError(response, this.options.policy, "deepinfra");
    const body = parseJson(await readBoundedBody(response, this.options.policy.maxResponseBytes));
    const result = parseProviderResult(body, {
      provider: "deepinfra",
      model: DEEPINFRA_MODEL,
      versionContract: this.options.versionContract ?? this.options.modelVersionPin,
      maxTextChars: this.options.policy.maxTextChars,
      maxSegments: this.options.policy.maxSegments,
      maxWords: this.options.policy.maxWords,
      maxAudioSeconds: this.options.policy.maxAudioSeconds,
    });
    requestIdentity(result, DEEPINFRA_MODEL);
    const observedIdentity = deepInfraExecutionIdentity(response, body);
    if (observedIdentity !== this.options.executionIdentityPin) {
      throw new ProviderError("provider execution identity mismatched release", "schema");
    }
    if (deepInfraModelVersion(response, body) !== this.options.modelVersionPin) {
      throw new ProviderError("provider model version mismatched release", "schema");
    }
    return { ...result, executionIdentity: observedIdentity };
  }
}

export class CloudflareWhisperProvider implements TranscriptionProvider {
  // fallow-ignore-next-line unused-class-member
  readonly name = "cloudflare" as const;
  private readonly options: CloudflareOptions;

  constructor(options: CloudflareOptions) {
    this.options = options;
  }

  async transcribe(request: ProviderRequest): Promise<ProviderResult> {
    if (request.audio.byteLength === 0 || request.audio.byteLength > this.options.policy.maxAudioBytes) throw new ProviderError("audio exceeded provider bound", "schema");
    if (!request.contentType.startsWith("audio/")) throw new ProviderError("audio content type is invalid", "schema");
    const signal = ensureAbortableTimeout(this.options.policy.timeoutMs, request.signal);
    const modelSlug = this.options.modelSlug ?? CLOUDFLARE_MODEL;
    const endpoint = this.options.endpoint ?? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/ai/run/${modelSlug}`;
    let response: Response;
    try {
      response = await this.options.fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
        body: JSON.stringify({ audio: Buffer.from(request.audio).toString("base64") }),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new ProviderError("provider request timed out", "timeout");
      throw new ProviderError("provider network request failed", "retryable");
    }
    if (!response.ok) throw await parseError(response, this.options.policy, "cloudflare");
    const body = parseJson(await readBoundedBody(response, this.options.policy.maxResponseBytes));
    const root = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    const resultPayload = root?.result ?? body;
    const result = parseProviderResult(resultPayload, {
      provider: "cloudflare",
      model: CLOUDFLARE_MODEL,
      versionContract: this.options.adapterContractVersion,
      maxTextChars: this.options.policy.maxTextChars,
      maxSegments: this.options.policy.maxSegments,
      maxWords: this.options.policy.maxWords,
      maxAudioSeconds: this.options.policy.maxAudioSeconds,
    });
    requestIdentity(result, CLOUDFLARE_MODEL);
    const rootRequestId = root?.request_id ?? root?.requestId;
    if (rootRequestId !== undefined && typeof rootRequestId !== "string") throw new ProviderError("provider request identity is invalid", "schema");
    const rootModel = root?.model;
    if (rootModel !== undefined && typeof rootModel !== "string") throw new ProviderError("provider model identity is invalid", "schema");
    if (rootModel !== undefined && rootModel !== CLOUDFLARE_MODEL) throw new ProviderError("provider model identity mismatched release", "schema");
    if (rootRequestId === undefined && rootModel === undefined) return result;
    return { ...result, providerIdentity: { ...(result.providerIdentity ?? {}), ...(rootRequestId === undefined ? {} : { requestId: rootRequestId }), ...(rootModel === undefined ? {} : { model: rootModel }) } };
  }
}

export type ProviderFactory = () => TranscriptionProvider;
