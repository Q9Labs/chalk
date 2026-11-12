import { ProviderError, providerFailureKind } from "./errors.js";
import type { ProviderPolicy, ProviderRequest, ProviderResult, TranscriptionProvider } from "./provider-types.js";

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

type PrimaryOutcome = { ok: true; result: ProviderResult; attempts: number } | { ok: false; failure: unknown; attempts: number };

export async function transcribeWithFallback(options: { primary?: TranscriptionProvider; fallback?: TranscriptionProvider; request: ProviderRequest; policy: ProviderPolicy; circuit: InvocationCircuit; runtime?: Partial<RetryRuntime> }): Promise<FallbackResult> {
  const { primary, fallback, request, policy, circuit } = options;
  const runtime: RetryRuntime = {
    sleep: options.runtime?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options.runtime?.random ?? Math.random,
    now: options.runtime?.now ?? Date.now,
  };
  if (!primary || circuit.isOpen(runtime.now())) {
    if (!fallback) throw new ProviderError("no available transcription provider", "retryable");
    return { result: await invokeProvider(fallback, request), providerAttempts: 1, usedFallback: true };
  }
  const outcome = await retryPrimary(primary, request, policy, circuit, runtime);
  if (outcome.ok) return { result: outcome.result, providerAttempts: outcome.attempts, usedFallback: false };
  if (!fallback) throw outcome.failure;
  return { result: await invokeProvider(fallback, request), providerAttempts: outcome.attempts + 1, usedFallback: true };
}

/** Tries the primary provider until it succeeds, fails for good, or the retries or the circuit run out. */
async function retryPrimary(primary: TranscriptionProvider, request: ProviderRequest, policy: ProviderPolicy, circuit: InvocationCircuit, runtime: RetryRuntime): Promise<PrimaryOutcome> {
  for (let retry = 0; ; retry += 1) {
    try {
      const result = await invokeProvider(primary, request);
      circuit.recordSuccess();
      return { ok: true, result, attempts: retry + 1 };
    } catch (error) {
      circuit.recordFailure(runtime.now());
      const kind = providerFailureKind(error);
      const canRetry = (kind === "retryable" || kind === "timeout") && retry < policy.maxRetries && !circuit.isOpen(runtime.now());
      if (!canRetry) return { ok: false, failure: error, attempts: retry + 1 };
      await runtime.sleep(backoff(policy, retry, runtime.random()));
    }
  }
}

async function invokeProvider(provider: TranscriptionProvider, request: ProviderRequest): Promise<ProviderResult> {
  const result = await provider.transcribe(request);
  if (result.segments.length === 0 && result.text.trim().length > 0) throw new ProviderError("provider returned no timings", "schema");
  return result;
}

function backoff(policy: ProviderPolicy, retry: number, random: number): number {
  const exponential = Math.min(policy.retryMaxDelayMs, policy.retryBaseDelayMs * 2 ** retry);
  const jitter = Math.max(0, Math.min(1, random));
  return Math.round(exponential * (0.5 + jitter * 0.5));
}
