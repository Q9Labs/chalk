import type { ChalkWhiteboardV1PendingOperation, ChalkWhiteboardV1PendingOperationStore } from "./types";

export class InMemoryChalkWhiteboardV1PendingOperationStore implements ChalkWhiteboardV1PendingOperationStore {
  readonly #operations = new Map<string, ChalkWhiteboardV1PendingOperation>();

  async load(): Promise<readonly ChalkWhiteboardV1PendingOperation[]> {
    return [...this.#operations.values()].map(copyPendingOperation);
  }

  async put(operation: ChalkWhiteboardV1PendingOperation): Promise<void> {
    this.#operations.set(operation.operationId, copyPendingOperation(operation));
  }

  async remove(operationId: string): Promise<void> {
    this.#operations.delete(operationId);
  }
}

export function compareChalkWhiteboardV1PendingOperations(left: ChalkWhiteboardV1PendingOperation, right: ChalkWhiteboardV1PendingOperation): number {
  return left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId);
}

function copyPendingOperation(operation: ChalkWhiteboardV1PendingOperation): ChalkWhiteboardV1PendingOperation {
  return { ...operation, frame: structuredClone(operation.frame) };
}
