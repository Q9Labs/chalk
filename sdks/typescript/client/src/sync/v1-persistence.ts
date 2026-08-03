import type { V1PendingTarget, V1PendingTargetStore } from "./v1-types";

export class InMemoryV1PendingTargetStore implements V1PendingTargetStore {
  readonly #commands = new Map<string, V1PendingTarget>();

  constructor(commands: readonly V1PendingTarget[] = []) {
    for (const command of commands) this.#commands.set(command.commandId, structuredClone(command));
  }

  async load(): Promise<readonly V1PendingTarget[]> {
    return [...this.#commands.values()].map((command) => structuredClone(command)).sort(comparePending);
  }

  async put(command: V1PendingTarget): Promise<void> {
    this.#commands.set(command.commandId, structuredClone(command));
  }

  async remove(commandId: string): Promise<void> {
    this.#commands.delete(commandId);
  }
}

export function compareV1PendingTargets(left: V1PendingTarget, right: V1PendingTarget): number {
  return comparePending(left, right);
}

function comparePending(left: V1PendingTarget, right: V1PendingTarget): number {
  return left.createdAt - right.createdAt || left.commandId.localeCompare(right.commandId);
}
