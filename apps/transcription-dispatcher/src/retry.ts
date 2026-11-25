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

export async function transcribeWithRetry(options: { provider: TranscriptionProvider; request: ProviderRequest; policy: ProviderPolicy; circuit: InvocationCircuit; runtime?: Partial<RetryRuntime> }): Promise<{ result: ProviderResult; providerAttempts: number }> {
  const { provider, request, policy, circuit } = options;
  const runtime: RetryRuntime = {
    sleep: options.runtime?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: options.runtime?.random ?? Math.random,
    now: options.runtime?.now ?? Date.now,
  };
  if (circuit.isOpen(runtime.now())) throw new ProviderError("transcription provider circuit is open", "retryable");
  for (let retry = 0; ; retry += 1) {
    try {
      const result = await provider.transcribe(request);
      if (result.segments.length === 0 && result.text.trim().length > 0) throw new ProviderError("provider returned no timings", "schema");
      circuit.recordSuccess();
      return { result, providerAttempts: retry + 1 };
    } catch (error) {
      circuit.recordFailure(runtime.now());
      const kind = providerFailureKind(error);
      const canRetry = (kind === "retryable" || kind === "timeout") && retry < policy.maxRetries && !circuit.isOpen(runtime.now());
      if (!canRetry) throw error;
      await runtime.sleep(backoff(policy, retry, runtime.random()));
    }
  }
}

function backoff(policy: ProviderPolicy, retry: number, random: number): number {
  const exponential = Math.min(policy.retryMaxDelayMs, policy.retryBaseDelayMs * 2 ** retry);
  const jitter = Math.max(0, Math.min(1, random));
  return Math.round(exponential * (0.5 + jitter * 0.5));
}
