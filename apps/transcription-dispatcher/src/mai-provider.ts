import { ProviderError, providerSchemaError } from "./errors.js";
import { classifyProviderStatus, parseJson, parseProviderResponse, parseProviderResult, readBoundedBody } from "./provider-utils.js";
import { prepareSpeechAudio } from "./speech-audio.js";
import type { ProviderPolicy, ProviderRequest, ProviderResult, TranscriptionProvider } from "./types.js";

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
    if (request.transcriptLanguage?.mode === "fixed") throw new ProviderError("MAI requires Auto language mode", "nonretryable");
    if (request.contentType !== "audio/flac" || !request.audio.length || request.audio.length > this.options.policy.maxAudioBytes) throw providerSchemaError("invalid MAI audio source", "audio", "bounded renderer FLAC", undefined);
    const signal = request.signal;
    const prepared = await prepareSpeechAudio(request.audio, this.options.policy.maxAudioSeconds);
    const segments: ProviderResult["segments"] = [];
    const words: NonNullable<ProviderResult["words"]> = [];
    const texts: string[] = [];
    let language: string | undefined;
    let cost = 0;
    let speechMs = 0;
    for (const batch of prepared.batches) {
      if (signal?.aborted) throw new ProviderError("MAI request timed out or was canceled", "timeout");
      const response = await this.post(
        "audio/transcriptions",
        {
          model: MODEL,
          input_audio: { data: Buffer.from(batch.audio).toString("base64"), format: "wav" },
          response_format: "verbose_json",
          timestamp_granularities: ["segment", "word"],
        },
        signal,
      );
      const result = await parseProviderResponse(response, this.options.policy.maxResponseBytes, (body) => {
        cost += reportedCost(body);
        return parseProviderResult(body, {
          provider: this.name,
          model: MODEL,
          versionContract: VERSION,
          maxTextChars: this.options.policy.maxTextChars,
          maxSegments: this.options.policy.maxSegments,
          maxWords: this.options.policy.maxWords,
          maxAudioSeconds: batch.durationSeconds + 0.05,
          onTimingRepair: request.onTimingRepair,
        });
      });
      if (result.text.trim() && !result.words?.length) throw providerSchemaError("MAI omitted requested word timestamps", "words", "nonempty timed words for speech", undefined);
      // Partial word timestamps must not discard the rest of a provider segment.
      const complete = {
        ...result,
        segments: result.segments.map((segment) => {
          const timedText = (result.words ?? [])
            .filter((word) => word.startSeconds < segment.endSeconds && word.endSeconds > segment.startSeconds)
            .map((word) => word.word)
            .join(" ");
          return lexicalText(timedText) === lexicalText(segment.text) ? segment : { ...segment, useSegmentText: true as const };
        }),
      };
      const converted = await this.convertScript(complete, signal);
      cost += converted.cost;
      language = converted.result.language ?? language;
      texts.push(converted.result.text);
      segments.push(...converted.result.segments.map((segment) => ({ ...segment, startSeconds: batch.sourceSeconds(segment.startSeconds, "start"), endSeconds: batch.sourceSeconds(segment.endSeconds, "end") })));
      words.push(...(converted.result.words ?? []).map((word) => ({ ...word, startSeconds: batch.sourceSeconds(word.startSeconds, "start"), endSeconds: batch.sourceSeconds(word.endSeconds, "end") })));
      speechMs += Math.round(batch.durationSeconds * 1000);
      if (segments.length > this.options.policy.maxSegments || words.length > this.options.policy.maxWords || texts.join(" ").length > this.options.policy.maxTextChars) throw providerSchemaError("MAI chunk exceeded output bounds", "result", "bounded chunk transcript", undefined);
    }
    return { provider: this.name, model: MODEL, versionContract: VERSION, text: texts.join(" "), segments, words, ...(language ? { language } : {}), durationMs: speechMs, providerReportedCostUsd: cost, quality: { segmentCount: segments.length, wordCount: words.length } };
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
    const body = parseJson(await readBoundedBody(response, this.options.policy.maxResponseBytes));
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
        await response.body?.cancel();
        throw new ProviderError("OpenRouter request failed", classifyProviderStatus(response.status, "openrouter"), { status: response.status });
      }
      return response;
    } catch (error) {
      if (signal?.aborted) throw new ProviderError("MAI request timed out or was canceled", "timeout");
      throw error;
    }
  }
}

function reportedCost(body: unknown): number {
  if (!body || typeof body !== "object" || !("usage" in body) || !body.usage || typeof body.usage !== "object" || !("cost" in body.usage) || typeof body.usage.cost !== "number" || !Number.isFinite(body.usage.cost) || body.usage.cost < 0 || body.usage.cost > 1000)
    throw providerSchemaError("OpenRouter omitted bounded usage cost", "usage.cost", "finite USD cost", undefined);
  return body.usage.cost;
}

function conversionTokens(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("choices" in body) || !Array.isArray(body.choices)) throw providerSchemaError("conversion choices missing", "choices", "chat response", undefined);
  const first: unknown = body.choices[0];
  if (!first || typeof first !== "object" || !("message" in first) || !first.message || typeof first.message !== "object" || !("content" in first.message) || typeof first.message.content !== "string") throw providerSchemaError("conversion content missing", "choices", "JSON content", undefined);
  const parsed = parseJson(new TextEncoder().encode(first.message.content));
  if (!parsed || typeof parsed !== "object" || !("tokens" in parsed) || !Array.isArray(parsed.tokens) || !parsed.tokens.every((token: unknown): token is string => typeof token === "string" && token.length <= 256))
    throw providerSchemaError("conversion tokens missing", "tokens", "bounded string array", undefined);
  return parsed.tokens;
}

function lexicalText(text: string): string {
  return text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "");
}
