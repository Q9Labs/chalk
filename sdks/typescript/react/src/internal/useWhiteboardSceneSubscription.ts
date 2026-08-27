import type { ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";

type WhiteboardSceneSubscription = { readonly status: "closed" | "loading" } | { readonly status: "ready"; readonly transport: ChalkWhiteboardV1Transport } | { readonly status: "failed"; readonly error: Error };

const errorMessage = (cause: unknown): Error => (cause instanceof Error ? cause : new Error("Whiteboard could not connect."));
const summaryError = (summary: ChalkWhiteboardSummary): Error => (summary.error ? new Error(summary.error.message) : errorMessage(undefined));
const MAX_RECOVERY_ATTEMPTS = 3;
const recoveryDelayMs = (attempt: number): number => 250 * 2 ** attempt;

export function useWhiteboardSceneSubscription(transport: ChalkWhiteboardV1Transport | null, active: boolean): WhiteboardSceneSubscription {
  const [subscription, setSubscription] = useState<WhiteboardSceneSubscription>({ status: "closed" });

  useEffect(() => {
    if (!active || !transport) {
      setSubscription({ status: "closed" });
      return;
    }

    let disposed = false;
    let starting = false;
    let startupSettled = false;
    let recoveryAttempts = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let latestSummary: ChalkWhiteboardSummary | undefined;
    const observesSummary = transport.subscribeSummary !== undefined;

    const clearRecoveryTimer = (): void => {
      if (recoveryTimer === undefined) return;
      globalThis.clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
    };

    const recover = (cause: unknown): void => {
      if (disposed || recoveryTimer !== undefined || starting) return;
      if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        setSubscription({ status: "failed", error: errorMessage(cause) });
        return;
      }
      const attempt = recoveryAttempts++;
      setSubscription({ status: "loading" });
      recoveryTimer = globalThis.setTimeout(() => {
        recoveryTimer = undefined;
        start();
      }, recoveryDelayMs(attempt));
    };

    const handleSummary = (summary: ChalkWhiteboardSummary): void => {
      latestSummary = summary;
      if (disposed) return;
      if (summary.status === "unsubscribed") {
        setSubscription({ status: "loading" });
        return;
      }
      if (summary.status === "ready") {
        if (!starting || startupSettled) {
          recoveryAttempts = 0;
          setSubscription({ status: "ready", transport });
        }
        return;
      }
      if (summary.status === "loading" || summary.status === "recovering") {
        setSubscription({ status: "loading" });
        return;
      }
      if (summary.status === "failed") {
        starting = false;
        setSubscription({ status: "loading" });
        recover(summaryError(summary));
      }
    };

    const start = (): void => {
      if (disposed || starting) return;
      clearRecoveryTimer();
      starting = true;
      startupSettled = false;
      setSubscription({ status: "loading" });
      void Promise.resolve()
        .then(() => transport.startSceneSubscription())
        .then(
          () => {
            starting = false;
            startupSettled = true;
            if (disposed) return;
            if (!latestSummary || latestSummary.status === "ready") {
              recoveryAttempts = 0;
              setSubscription({ status: "ready", transport });
            }
          },
          (cause: unknown) => {
            starting = false;
            if (!disposed && observesSummary) recover(cause);
            else if (!disposed) setSubscription({ status: "failed", error: errorMessage(cause) });
          },
        );
    };

    setSubscription({ status: "loading" });
    const unsubscribeSummary = transport.subscribeSummary?.(handleSummary);
    start();

    return () => {
      disposed = true;
      clearRecoveryTimer();
      unsubscribeSummary?.();
      void Promise.resolve(transport.stopSceneSubscription());
    };
  }, [active, transport]);

  return subscription;
}
