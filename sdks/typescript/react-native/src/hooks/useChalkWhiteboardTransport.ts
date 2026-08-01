import type { ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";

import { useChalkSession } from "../context/chalk-provider";

export function useChalkWhiteboardTransport(): ChalkWhiteboardV1Transport {
  const session = useChalkSession();
  if (!session.whiteboard) {
    throw new Error("The whiteboard-v1 transport is not available in this environment.");
  }
  return session.whiteboard;
}
