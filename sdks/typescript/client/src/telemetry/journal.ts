import { EVENTS } from "../obs/registry";
import type { DropGroup } from "./drops";
import { PRIORITY } from "./priority";
import type { DropReason, SourceEnd, TelemetryCredential, TelemetryEvent, TelemetryRecord, WireEvent } from "./types";

/** What one source leaves behind for a reload to find, so its P0 records, its drop list and its end still reach the server under its own credential. A source is one join: it has one subject. */
export type SourceJournal = {
  readonly version: 2;
  readonly sourceId: string;
  /** The subject the source records for, or null before its first credential. */
  readonly subject: string | null;
  /** The high-water mark as of the last save. It is saved before every send, so it is at least every `next_seq` the source reported, and exact when `closing` is set. */
  readonly next: number;
  /** The source saved its exact high-water mark as it closed (`pagehide` or disposal). */
  readonly closing: boolean;
  /** The end the client still owes the server, or null. A successor sets it when it takes the source over. */
  readonly end: SourceEnd | null;
  /** The newest credential of the subject, while it is valid. */
  readonly credential: TelemetryCredential | null;
  /** P0 records not yet settled. */
  readonly records: readonly WireEvent[];
  readonly drops: readonly DropGroup[];
};

const DROP_REASONS: ReadonlySet<string> = new Set<DropReason>(["queue_full", "credential_expired", "refused"]);

export function writeJournalText(journal: SourceJournal): string {
  return JSON.stringify(journal);
}

/** Reads a journal text back, or null when it is not one this version wrote. */
export function readJournalText(text: string): SourceJournal | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || value.version !== 2 || typeof value.sourceId !== "string" || !isCount(value.next) || typeof value.closing !== "boolean") return null;
  const end = value.end === "closed" || value.end === "abandoned" ? value.end : value.end === null ? null : undefined;
  const subject = value.subject === null || typeof value.subject === "string" ? value.subject : undefined;
  if (end === undefined || subject === undefined || !Array.isArray(value.records) || !Array.isArray(value.drops)) return null;
  const credential = isCredential(value.credential) && value.credential.subject === subject ? value.credential : null;
  const records = value.records.filter((record: unknown) => isEvent(record) || isKernelRecord(record));
  const drops = value.drops.filter(isDropGroup);
  return { version: 2, sourceId: value.sourceId, subject, next: value.next, closing: value.closing, end, credential, records, drops };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCredential(value: unknown): value is TelemetryCredential {
  return isObject(value) && typeof value.tenantId === "string" && typeof value.subject === "string" && typeof value.token === "string" && typeof value.expiresAt === "number";
}

function isEvent(value: unknown): value is TelemetryEvent {
  return isObject(value) && typeof value.type === "string" && Object.hasOwn(PRIORITY, value.type) && isCount(value.seq) && typeof value.event_id === "string" && typeof value.elapsed_ms === "number";
}

const KERNEL_KINDS: ReadonlyMap<string, string> = new Map(Object.entries(EVENTS).map(([name, spec]) => [name, spec.kind]));

const isRecordValue = (value: unknown): boolean => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (isObject(value) && Object.values(value).every((member) => member === null || isRecordValue(member)));

/** A record the kernel made and the outbox gave a seq: a registry event of its declared kind, and only values a record can hold. The API checks the fields again. */
function isKernelRecord(value: unknown): value is TelemetryRecord {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.kind !== "string") return false;
  return KERNEL_KINDS.get(value.name) === value.kind && isCount(value.seq) && typeof value.event_id === "string" && Object.values(value).every(isRecordValue);
}

function isDropGroup(value: unknown): value is DropGroup {
  return isObject(value) && typeof value.reason === "string" && DROP_REASONS.has(value.reason) && Array.isArray(value.ranges) && value.ranges.every((range: unknown) => isObject(range) && isCount(range.from) && isCount(range.to));
}
