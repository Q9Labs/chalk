import type { DropGroup } from "./drops";
import { PRIORITY } from "./priority";
import type { DropReason, SourceEnd, TelemetryCredential, TelemetryEvent } from "./types";

/** What one source leaves behind for a reload to find, so its P0 records, its drop list and its end still reach the server. */
export type SourceJournal = {
  readonly version: 1;
  readonly sourceId: string;
  /** The high-water mark as of the last save. Exact when `closing` is set. */
  readonly next: number;
  /** The source saved its exact high-water mark as it closed (`pagehide` or disposal). */
  readonly closing: boolean;
  /** The end the client still owes the server, or null. A successor sets it when it takes the source over. */
  readonly end: SourceEnd | null;
  readonly credentials: readonly TelemetryCredential[];
  /** P0 records not yet settled, with the subject each leaves under. */
  readonly records: readonly { readonly event: TelemetryEvent; readonly subject: string | null }[];
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
  if (!isObject(value) || value.version !== 1 || typeof value.sourceId !== "string" || !isCount(value.next) || typeof value.closing !== "boolean") return null;
  const end = value.end === "closed" || value.end === "abandoned" ? value.end : value.end === null ? null : undefined;
  if (end === undefined || !Array.isArray(value.credentials) || !Array.isArray(value.records) || !Array.isArray(value.drops)) return null;
  const credentials = value.credentials.filter(isCredential);
  const records = value.records.flatMap((record: unknown) => (isObject(record) && isEvent(record.event) && (record.subject === null || typeof record.subject === "string") ? [{ event: record.event, subject: record.subject }] : []));
  const drops = value.drops.filter(isDropGroup);
  return { version: 1, sourceId: value.sourceId, next: value.next, closing: value.closing, end, credentials, records, drops };
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

function isDropGroup(value: unknown): value is DropGroup {
  return isObject(value) && typeof value.source === "string" && typeof value.reason === "string" && DROP_REASONS.has(value.reason) && Array.isArray(value.ranges) && value.ranges.every((range: unknown) => isObject(range) && isCount(range.from) && isCount(range.to));
}
