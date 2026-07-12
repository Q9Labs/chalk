import type { PendingCommand } from "./types";

type UnknownRecord = Record<string, unknown>;

export function isPendingCommand(value: unknown): value is PendingCommand {
  return isUnknownRecord(value) && hasPendingCommandMetadata(value) && isPendingCommandType(value.command);
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object";
}

function hasPendingCommandMetadata(value: UnknownRecord): boolean {
  return typeof value.commandId === "string" && typeof value.createdAt === "number" && typeof value.bytes === "number";
}

function isPendingCommandType(value: unknown): value is PendingCommand["command"] {
  return isUnknownRecord(value) && isPendingCommandName(value.name);
}

function isPendingCommandName(value: unknown): value is PendingCommand["command"]["name"] {
  return value === "raise_hand" || value === "lower_hand";
}
