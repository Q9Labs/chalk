import type { PendingCommand } from "./types";

export type PendingCommandStore = {
  load(): Promise<readonly PendingCommand[]>;
  put(command: PendingCommand): Promise<void>;
  remove(commandId: string): Promise<void>;
};

export class InMemoryPendingCommandStore implements PendingCommandStore {
  readonly #commands = new Map<string, PendingCommand>();

  constructor(commands: readonly PendingCommand[] = []) {
    for (const command of commands) {
      this.#commands.set(command.commandId, copyPendingCommand(command));
    }
  }

  async load(): Promise<readonly PendingCommand[]> {
    return [...this.#commands.values()].map(copyPendingCommand).sort(comparePendingCommands);
  }

  async put(command: PendingCommand): Promise<void> {
    this.#commands.set(command.commandId, copyPendingCommand(command));
  }

  async remove(commandId: string): Promise<void> {
    this.#commands.delete(commandId);
  }
}

export function comparePendingCommands(left: PendingCommand, right: PendingCommand): number {
  return left.createdAt - right.createdAt || compareCommandIds(left.commandId, right.commandId);
}

function compareCommandIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function copyPendingCommand(command: PendingCommand): PendingCommand {
  return {
    ...command,
    command: {
      ...command.command,
      ...(command.command.payload ? { payload: { ...command.command.payload } } : {}),
    },
  };
}
