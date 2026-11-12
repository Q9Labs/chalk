import { ProviderError, providerSchemaError } from "./errors.js";
import { classifyProviderStatus, openRouterReason } from "./provider-failure.js";
import { parseJson, parseProviderResponse, parseProviderResult, readProviderBody, valueAt } from "./provider-response.js";
import { prepareSpeechAudio, type SpeechBatch } from "./speech-audio.js";
import type { ProviderPolicy, ProviderRequest, ProviderResult, TranscriptionProvider } from "./provider-types.js";

const MODEL = "microsoft/mai-transcribe-2";
const VERSION = "openrouter-mai-2-urdu.v1";
const DEVANAGARI = /\p{Script=Devanagari}[\p{Script=Devanagari}\p{M}]*/gu;

interface Options {
  fetch: typeof fetch;
  token: string;
  policy: ProviderPolicy;
}

export class MaiTranscribeProvider implements TranscriptionProvider {
  readonly name = "openrouter" as const;
  constructor(private readonly options: Options) {}

  async transcribe(request: ProviderRequest): Promise<ProviderResult> {
    const { policy } = this.options;
    if (request.transcriptLanguage?.mode === "fixed") throw new ProviderError("MAI requires Auto language mode", "nonretryable");
    if (request.contentType !== "audio/flac" || !request.audio.length || request.audio.length > policy.maxAudioBytes) throw providerSchemaError("invalid MAI audio source", "audio", "bounded renderer FLAC", undefined);
    const prepared = await prepareSpeechAudio(request.audio, policy.maxAudioSeconds);
    const segments: ProviderResult["segments"] = [];
    const words: NonNullable<ProviderResult["words"]> = [];
    const texts: string[] = [];
    let language: string | undefined;
    let cost = 0;
    let speechMs = 0;
    for (const batch of prepared.batches) {
      if (request.signal?.aborted) throw new ProviderError("MAI request timed out or was canceled", "timeout");
      const done = await this.transcribeBatch(batch, request);
      cost += done.cost;
      language = done.result.language ?? language;
      texts.push(done.result.text);
      segments.push(...done.result.segments);
      words.push(...(done.result.words ?? []));
      speechMs += Math.round(batch.durationSeconds * 1000);
      if (segments.length > policy.maxSegments || words.length > policy.maxWords || texts.join(" ").length > policy.maxTextChars) throw providerSchemaError("MAI chunk exceeded output bounds", "result", "bounded chunk transcript", undefined);
    }
    return { provider: this.name, model: MODEL, versionContract: VERSION, text: texts.join(" "), segments, words, ...(language ? { language } : {}), durationMs: speechMs, providerReportedCostUsd: cost, quality: { segmentCount: segments.length, wordCount: words.length } };
  }

  /** Transcribes one batch of packed speech and maps its timings back onto the source audio. */
  private async transcribeBatch(batch: SpeechBatch, request: ProviderRequest): Promise<{ result: ProviderResult; cost: number }> {
    const { policy } = this.options;
    const response = await this.post(
      "audio/transcriptions",
      {
        model: MODEL,
        input_audio: { data: Buffer.from(batch.audio).toString("base64"), format: "wav" },
        response_format: "verbose_json",
        timestamp_granularities: ["segment", "word"],
      },
      request.signal,
    );
    let cost = 0;
    const parsed = await parseProviderResponse(response, policy.maxResponseBytes, (body) => {
      cost += reportedCost(body);
      return parseProviderResult(body, {
        provider: this.name,
        model: MODEL,
        versionContract: VERSION,
        maxTextChars: policy.maxTextChars,
        maxSegments: policy.maxSegments,
        maxWords: policy.maxWords,
        maxAudioSeconds: batch.durationSeconds + 0.05,
        onTimingRepair: request.onTimingRepair,
      });
    });
    if (parsed.text.trim() && !parsed.words?.length) throw providerSchemaError("MAI omitted requested word timestamps", "words", "nonempty timed words for speech", undefined);
    const converted = await this.convertScript(keepUntimedSegmentText(parsed), request.signal);
    const toSource = <Timed extends { startSeconds: number; endSeconds: number }>(item: Timed): Timed => ({ ...item, startSeconds: batch.sourceSeconds(item.startSeconds, "start"), endSeconds: batch.sourceSeconds(item.endSeconds, "end") });
    const { words } = converted.result;
    return {
      cost: cost + converted.cost,
      result: { ...converted.result, segments: converted.result.segments.map(toSource), ...(words ? { words: words.map(toSource) } : {}) },
    };
  }

  private async convertScript(result: ProviderResult, signal: AbortSignal | undefined): Promise<{ result: ProviderResult; cost: number }> {
    const tokens = [...new Set([result.text, ...result.segments.map((s) => s.text), ...(result.words ?? []).map((w) => w.word)].flatMap((text) => text.match(DEVANAGARI) ?? []))];
    if (!tokens.length) return { result, cost: 0 };
    const response = await this.post(
      "chat/completions",
      {
        model: "openai/gpt-4.1-mini",
        temperature: 0,
        max_tokens: 4096,
        response_format: { type: "json_schema", json_schema: { name: "urdu_script", strict: true, schema: { type: "object", properties: { tokens: { type: "array", items: { type: "string" } } }, required: ["tokens"], additionalProperties: false } } },
        messages: [
          { role: "system", content: 'Transliterate each Devanagari word into Urdu script. Do not translate, add or omit words. Return JSON {"tokens":[...]} in the exact input order, one Urdu string per word. Example: मेरा becomes میرا. Never return Devanagari or Latin letters.' },
          { role: "user", content: JSON.stringify(tokens) },
        ],
      },
      signal,
    );
    const body = parseJson(await readProviderBody(response, this.options.policy.maxResponseBytes));
    const output = conversionTokens(body);
    if (output.length !== tokens.length || output.some((text) => !text.trim() || !/^[\p{Script=Arabic}\p{M}\p{N}\p{P}\s]+$/u.test(text) || /\p{Script=Devanagari}/u.test(text))) throw providerSchemaError("Urdu script conversion was invalid", "choices", "one Urdu token per input token", undefined);
    const lookup = new Map(tokens.map((token, index) => [token, output[index] ?? ""]));
    const convert = (text: string) => text.replace(DEVANAGARI, (token) => lookup.get(token) ?? token).replace(/[।॥]/gu, "۔");
    return {
      cost: reportedCost(body),
      result: { ...result, text: convert(result.text), language: "ur", segments: result.segments.map((segment) => ({ ...segment, text: convert(segment.text) })), ...(result.words ? { words: result.words.map((word) => ({ ...word, word: convert(word.word) })) } : {}) },
    };
  }

  private async post(path: string, body: object, parent: AbortSignal | undefined): Promise<Response> {
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.policy.timeoutMs), ...(parent ? [parent] : [])]);
    try {
      const response = await this.options.fetch(`https://openrouter.ai/api/v1/${path}`, { method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, provider: { zdr: true, data_collection: "deny" } }), signal });
      if (!response.ok) {
        const providerCode = await openRouterReason(response);
        throw new ProviderError("OpenRouter request failed", classifyProviderStatus(response.status, "openrouter"), { status: response.status, ...(providerCode === undefined ? {} : { providerCode }) });
      }
      return response;
    } catch (error) {
      if (signal?.aborted) throw new ProviderError("MAI request timed out or was canceled", "timeout");
      throw error;
    }
  }
}

function reportedCost(body: unknown): number {
  const cost = valueAt(body, "usage", "cost");
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > 1000) throw providerSchemaError("OpenRouter omitted bounded usage cost", "usage.cost", "finite USD cost", undefined);
  return cost;
}

function conversionTokens(body: unknown): string[] {
  const choices = valueAt(body, "choices");
  if (!Array.isArray(choices)) throw providerSchemaError("conversion choices missing", "choices", "chat response", undefined);
  const content = valueAt(choices[0], "message", "content");
  if (typeof content !== "string") throw providerSchemaError("conversion content missing", "choices", "JSON content", undefined);
  const tokens = valueAt(parseJson(new TextEncoder().encode(content)), "tokens");
  if (!Array.isArray(tokens) || !tokens.every((token: unknown): token is string => typeof token === "string" && token.length <= 256)) throw providerSchemaError("conversion tokens missing", "tokens", "bounded string array", undefined);
  return tokens;
}

/** Partial word timestamps must not discard the rest of a provider segment: a segment whose words do not spell its text keeps its own text. */
function keepUntimedSegmentText(result: ProviderResult): ProviderResult {
  return {
    ...result,
    segments: result.segments.map((segment) => {
      const timedText = (result.words ?? [])
        .filter((word) => word.startSeconds < segment.endSeconds && word.endSeconds > segment.startSeconds)
        .map((word) => word.word)
        .join(" ");
      return lexicalText(timedText) === lexicalText(segment.text) ? segment : { ...segment, useSegmentText: true as const };
    }),
  };
}

function lexicalText(text: string): string {
  return text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "");
}
