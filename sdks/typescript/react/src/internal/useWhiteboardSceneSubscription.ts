import type { ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";

type WhiteboardSceneSubscription = { readonly status: "closed" | "loading" } | { readonly status: "ready"; readonly transport: ChalkWhiteboardV1Transport } | { readonly status: "failed"; readonly error: Error };

const errorMessage = (cause: unknown): Error => (cause instanceof Error ? cause : new Error("Whiteboard could not connect."));

export function useWhiteboardSceneSubscription(transport: ChalkWhiteboardV1Transport | null, active: boolean): WhiteboardSceneSubscription {
  const [subscription, setSubscription] = useState<WhiteboardSceneSubscription>({ status: "closed" });

  useEffect(() => {
    if (!active || !transport) {
      setSubscription({ status: "closed" });
      return;
    }

    let disposed = false;
    setSubscription({ status: "loading" });
    void Promise.resolve()
      .then(() => transport.startSceneSubscription())
      .then(
        () => {
          if (!disposed) setSubscription({ status: "ready", transport });
        },
        (cause: unknown) => {
          if (!disposed) setSubscription({ status: "failed", error: errorMessage(cause) });
        },
      );

    return () => {
      disposed = true;
      void Promise.resolve(transport.stopSceneSubscription());
    };
  }, [active, transport]);

  return subscription;
}
