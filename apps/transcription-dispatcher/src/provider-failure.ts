import { isObject, parseJson, readProviderBody, valueAt } from "./provider-response.js";
import type { ProviderResult } from "./provider-types.js";

// Cloudflare marks some 408 and 429 answers as transient by code; every 5xx is transient.
const CLOUDFLARE_TRANSIENT_CODES = new Map<number, readonly string[]>([
  [408, ["3007", "3008"]],
  [429, ["3040"]],
]);

export function classifyProviderStatus(status: number, provider: ProviderResult["provider"], code?: string): "retryable" | "nonretryable" {
  if (provider === "cloudflare") {
    const transient = status >= 500 || (code !== undefined && CLOUDFLARE_TRANSIENT_CODES.get(status)?.includes(code));
    return transient ? "retryable" : "nonretryable";
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "retryable";
  // OpenRouter answers 402 while the account credit is short, for example during an automatic reload, so a later attempt can succeed.
  return provider === "openrouter" && status === 402 ? "retryable" : "nonretryable";
}

// OpenRouter names why it refused a request in error.metadata.reason (for example in_flight_budget_exhausted). Only a short snake_case word or number is kept, so the body's free text never reaches a log.
const REASON_WORD = /^(?:[a-z][a-z_]{0,63}|\d{1,6})$/;

export function isReasonWord(value: string): boolean {
  return REASON_WORD.test(value);
}

export async function openRouterReason(response: Response): Promise<string | undefined> {
  try {
    const reason = valueAt(parseJson(await readProviderBody(response, 4096)), "error", "metadata", "reason");
    return typeof reason === "string" && isReasonWord(reason) ? reason : undefined;
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
}

export function errorCodeFromBody(value: unknown): string | undefined {
  const errors = valueAt(value, "errors");
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const code = valueAt(isObject(first) ? first : value, "code");
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

export function ensureAbortableTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}
