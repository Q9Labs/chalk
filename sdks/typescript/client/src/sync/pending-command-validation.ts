import { pendingCommandBytes } from "./client-state";
import { SyncCommandValidationError } from "./errors";
import type { PendingCommand, SyncCommand } from "./types";

type UnknownRecord = Record<string, unknown>;

export type PendingCommandLimits = {
  readonly maxPendingCommands: number;
  readonly maxPendingBytes: number;
  readonly maxPendingAgeMs: number;
};

export type PendingCommandLimitOptions = Partial<PendingCommandLimits>;

export const MAX_PENDING_COMMANDS = 256;
export const MAX_PENDING_BYTES = 1024 * 1024;
export const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;

const commandIdPattern = /^[A-Za-z0-9_-]{16,64}$/;

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

export function pendingLimitsFrom(limits: PendingCommandLimitOptions | undefined): PendingCommandLimits {
  return {
    maxPendingCommands: limits?.maxPendingCommands ?? MAX_PENDING_COMMANDS,
    maxPendingBytes: limits?.maxPendingBytes ?? MAX_PENDING_BYTES,
    maxPendingAgeMs: limits?.maxPendingAgeMs ?? MAX_PENDING_AGE_MS,
  };
}

export function validateLimits(limits: PendingCommandLimits): void {
  if (![limits.maxPendingCommands, limits.maxPendingBytes, limits.maxPendingAgeMs].every(isPositiveInteger)) {
    throw new RangeError("pending command limits must be positive");
  }
}

export function validateCommand(command: SyncCommand): void {
  if (!isSupportedCommand(command)) {
    throw new SyncCommandValidationError("unsupported sync command");
  }
  try {
    pendingCommandBytes("validation-command-id", command);
  } catch {
    throw new SyncCommandValidationError("command payload must be canonical JSON");
  }
}

export function isCommandId(value: string): boolean {
  return commandIdPattern.test(value);
}

export function isStoredPending(value: PendingCommand): boolean {
  return isCommandId(value.commandId) && Number.isFinite(value.createdAt) && Number.isInteger(value.bytes) && value.bytes > 0;
}

export function comparePending(left: PendingCommand, right: PendingCommand): number {
  return left.createdAt - right.createdAt || (left.commandId < right.commandId ? -1 : left.commandId > right.commandId ? 1 : 0);
}

export function copyPending(pending: PendingCommand): PendingCommand {
  return { ...pending, command: { ...pending.command, ...(pending.command.payload ? { payload: { ...pending.command.payload } } : {}) } };
}

function isSupportedCommand(command: SyncCommand): boolean {
  return (command.name === "raise_hand" || command.name === "lower_hand") && isEmptyCommandPayload(command.payload);
}

function isEmptyCommandPayload(payload: SyncCommand["payload"]): boolean {
  return !payload || (isRecord(payload) && Object.keys(payload).length === 0);
}

function isRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
