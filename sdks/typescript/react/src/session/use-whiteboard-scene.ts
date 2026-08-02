import type { ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useEffect } from "react";

type WhiteboardSceneTransport = Pick<ChalkWhiteboardV1Transport, "startSceneSubscription" | "stopSceneSubscription">;

export function useWhiteboardScene(whiteboard: WhiteboardSceneTransport | null, isOpen: boolean, onError: (message: string) => void): void {
  useEffect(() => {
    if (!isOpen || !whiteboard) return;

    let active = true;
    void whiteboard.startSceneSubscription().catch((cause: unknown) => {
      if (active) onError(cause instanceof Error ? cause.message : "Whiteboard connection failed");
    });
    return () => {
      active = false;
      whiteboard.stopSceneSubscription();
    };
  }, [isOpen, onError, whiteboard]);
}
