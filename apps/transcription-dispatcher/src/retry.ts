import { ProviderError, providerFailureKind } from "./errors.js";
import type { ProviderPolicy, ProviderRequest, ProviderResult, TranscriptionProvider } from "./types.js";

export class InvocationCircuit {
  private failures = 0;
  private openedUntil = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  isOpen(now = Date.now()): boolean {
    return this.openedUntil > now;
  }

  recordFailure(now = Date.now()): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedUntil = now + this.cooldownMs;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedUntil = 0;
  }
}

export interface RetryRuntime {
  sleep(ms: number): Promise<void>;
  random(): number;
  now(): number;
}

export interface FallbackResult {
  result: ProviderResult;
  providerAttempts: number;
  usedFallback: boolean;
}

export async function transcribeWithFallback(options: { primary?: TranscriptionProvider; fallback: TranscriptionProvider; request: ProviderRequest; policy: ProviderPolicy; circuit: InvocationCircuit; runtime?: Partial<RetryRuntime> }): Promise<FallbackResult> {
  const runtime: RetryRuntime = {
    sleep: options.runtime?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options.runtime?.random ?? Math.random,
    now: options.runtime?.now ?? Date.now,
  };
  if (!options.primary || options.circuit.isOpen(runtime.now())) {
    return { result: await invokeProvider(options.fallback, options.request, options.policy, runtime), providerAttempts: 1, usedFallback: true };
  }
  let attempts = 0;
  for (let retry = 0; retry <= options.policy.maxRetries; retry += 1) {
    attempts += 1;
    try {
      const result = await invokeProvider(options.primary, options.request, options.policy, runtime);
      options.circuit.recordSuccess();
      return { result, providerAttempts: attempts, usedFallback: false };
    } catch (error) {
      const kind = providerFailureKind(error);
      if (kind !== "retryable" && kind !== "timeout") {
        options.circuit.recordFailure(runtime.now());
        break;
      }
      options.circuit.recordFailure(runtime.now());
      if (retry >= options.policy.maxRetries || options.circuit.isOpen(runtime.now())) break;
      await runtime.sleep(backoff(options.policy, retry, runtime.random()));
    }
  }
  const result = await invokeProvider(options.fallback, options.request, options.policy, runtime);
  return { result, providerAttempts: attempts + 1, usedFallback: true };
}

async function invokeProvider(provider: TranscriptionProvider, request: ProviderRequest, policy: ProviderPolicy, runtime: RetryRuntime): Promise<ProviderResult> {
  const result = await provider.transcribe(request);
  if (result.segments.length === 0) throw new ProviderError("provider returned no timings", "schema");
  return result;
}

function backoff(policy: ProviderPolicy, retry: number, random: number): number {
  const exponential = Math.min(policy.retryMaxDelayMs, policy.retryBaseDelayMs * 2 ** retry);
  const jitter = Math.max(0, Math.min(1, random));
  return Math.round(exponential * (0.5 + jitter * 0.5));
}
