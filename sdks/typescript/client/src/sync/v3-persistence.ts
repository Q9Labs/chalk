import type { V3PendingTarget, V3PendingTargetStore } from "./v3-types";

export class InMemoryV3PendingTargetStore implements V3PendingTargetStore {
  readonly #commands = new Map<string, V3PendingTarget>();

  constructor(commands: readonly V3PendingTarget[] = []) {
    for (const command of commands) this.#commands.set(command.commandId, structuredClone(command));
  }

  async load(): Promise<readonly V3PendingTarget[]> {
    return [...this.#commands.values()].map((command) => structuredClone(command)).sort(comparePending);
  }

  async put(command: V3PendingTarget): Promise<void> {
    this.#commands.set(command.commandId, structuredClone(command));
  }

  async remove(commandId: string): Promise<void> {
    this.#commands.delete(commandId);
  }
}

export function compareV3PendingTargets(left: V3PendingTarget, right: V3PendingTarget): number {
  return comparePending(left, right);
}

function comparePending(left: V3PendingTarget, right: V3PendingTarget): number {
  return left.createdAt - right.createdAt || left.commandId.localeCompare(right.commandId);
}
