import type { MeetingEndData, MeetingStats } from "../components/full/video-conference/types";

const MEETING_END_SUMMARY_STORAGE_VERSION = 1;
const DEFAULT_MEETING_END_SUMMARY_TTL_MS = 15 * 60_000;

export const MEETING_END_SUMMARY_STORAGE_KEY = "chalk-meeting-end-summary";

export interface MeetingEndSummary {
  roomId: string;
  roomName: string | null;
  durationSeconds: number;
  participantCount: number;
  totalParticipants: number;
  hostId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  stats: MeetingStats;
}

export interface MeetingEndSummaryEnvelope {
  version: number;
  writtenAtMs: number;
  expiresAtMs: number;
  summary: MeetingEndSummary;
}

interface ReadMeetingEndSummaryOptions {
  roomId?: string;
  nowMs?: number;
  storage?: Storage;
}

interface WriteMeetingEndSummaryOptions {
  nowMs?: number;
  ttlMs?: number;
  storage?: Storage;
}

interface BuildMeetingEndSummaryOptions {
  roomName?: string | null;
  nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number") {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDateMs(value: Date | number | string, fallbackMs: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallbackMs;
  }

  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : fallbackMs;
  }

  return fallbackMs;
}

function cloneStats(stats: MeetingStats): MeetingStats {
  return {
    chatMessageCount: stats.chatMessageCount,
    reactionCount: stats.reactionCount,
    handRaiseCount: stats.handRaiseCount,
    screenShareCount: stats.screenShareCount,
    whiteboardOpened: stats.whiteboardOpened,
    recordingDuration: stats.recordingDuration,
  };
}

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) {
    return storage;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    // Ignore and fallback below.
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseMeetingEndSummaryEnvelope(raw: string): MeetingEndSummaryEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.summary)) {
      return null;
    }

    const version = toNumberOrNull(parsed.version);
    const writtenAtMs = toNumberOrNull(parsed.writtenAtMs);
    const expiresAtMs = toNumberOrNull(parsed.expiresAtMs);
    if (version !== MEETING_END_SUMMARY_STORAGE_VERSION || writtenAtMs === null || expiresAtMs === null) {
      return null;
    }

    const summaryRecord = parsed.summary;
    const roomId = typeof summaryRecord.roomId === "string" ? summaryRecord.roomId : null;
    const roomName = toOptionalString(summaryRecord.roomName);
    const durationSeconds = toNumberOrNull(summaryRecord.durationSeconds);
    const participantCount = toNumberOrNull(summaryRecord.participantCount);
    const totalParticipants = toNumberOrNull(summaryRecord.totalParticipants);
    const hostId = toOptionalString(summaryRecord.hostId);
    const startedAtMs = toNumberOrNull(summaryRecord.startedAtMs);
    const endedAtMs = toNumberOrNull(summaryRecord.endedAtMs);
    const stats = summaryRecord.stats;

    if (!roomId || durationSeconds === null || participantCount === null || totalParticipants === null || startedAtMs === null || endedAtMs === null || !isRecord(stats)) {
      return null;
    }

    const normalizedStats: MeetingStats = {
      chatMessageCount: toNumberOrNull(stats.chatMessageCount) ?? 0,
      reactionCount: toNumberOrNull(stats.reactionCount) ?? 0,
      handRaiseCount: toNumberOrNull(stats.handRaiseCount) ?? 0,
      screenShareCount: toNumberOrNull(stats.screenShareCount) ?? 0,
      whiteboardOpened: typeof stats.whiteboardOpened === "boolean" ? stats.whiteboardOpened : false,
      recordingDuration: toNumberOrNull(stats.recordingDuration) ?? 0,
    };

    return {
      version,
      writtenAtMs,
      expiresAtMs,
      summary: {
        roomId,
        roomName,
        durationSeconds,
        participantCount,
        totalParticipants,
        hostId,
        startedAtMs,
        endedAtMs,
        stats: normalizedStats,
      },
    };
  } catch {
    return null;
  }
}

function clearStoredMeetingEndSummary(storage: Storage | null) {
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(MEETING_END_SUMMARY_STORAGE_KEY);
  } catch {
    // Best effort cleanup.
  }
}

export function clearMeetingEndSummary(options: { storage?: Storage } = {}) {
  clearStoredMeetingEndSummary(resolveStorage(options.storage));
}

export function buildMeetingEndSummary(data: MeetingEndData, options: BuildMeetingEndSummaryOptions = {}): MeetingEndSummary {
  const nowMs = options.nowMs ?? Date.now();
  const startedAtMs = toDateMs(data.startedAt, nowMs);
  const endedAtMs = toDateMs(data.endedAt, nowMs);

  return {
    roomId: data.roomId,
    roomName: toOptionalString(options.roomName) ?? null,
    durationSeconds: Math.max(0, Math.round(data.duration)),
    participantCount: Math.max(0, Math.round(data.participantCount)),
    totalParticipants: Math.max(0, Math.round(data.totalParticipants)),
    hostId: toOptionalString(data.hostId),
    startedAtMs,
    endedAtMs,
    stats: cloneStats(data.stats),
  };
}

export function writeMeetingEndSummary(summary: MeetingEndSummary, options: WriteMeetingEndSummaryOptions = {}): MeetingEndSummaryEnvelope | null {
  const storage = resolveStorage(options.storage);
  if (!storage) {
    return null;
  }

  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_MEETING_END_SUMMARY_TTL_MS;
  const envelope: MeetingEndSummaryEnvelope = {
    version: MEETING_END_SUMMARY_STORAGE_VERSION,
    writtenAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    summary: {
      ...summary,
      roomName: toOptionalString(summary.roomName) ?? null,
      hostId: toOptionalString(summary.hostId),
      durationSeconds: Math.max(0, Math.round(summary.durationSeconds)),
      participantCount: Math.max(0, Math.round(summary.participantCount)),
      totalParticipants: Math.max(0, Math.round(summary.totalParticipants)),
      startedAtMs: Math.max(0, Math.round(summary.startedAtMs)),
      endedAtMs: Math.max(0, Math.round(summary.endedAtMs)),
      stats: cloneStats(summary.stats),
    },
  };

  try {
    storage.setItem(MEETING_END_SUMMARY_STORAGE_KEY, JSON.stringify(envelope));
    return envelope;
  } catch {
    return null;
  }
}

export function writeMeetingEndSummaryFromData(data: MeetingEndData, options: BuildMeetingEndSummaryOptions & WriteMeetingEndSummaryOptions = {}): MeetingEndSummaryEnvelope | null {
  return writeMeetingEndSummary(buildMeetingEndSummary(data, options), options);
}

export function readMeetingEndSummary(options: ReadMeetingEndSummaryOptions = {}): MeetingEndSummary | null {
  const storage = resolveStorage(options.storage);
  if (!storage) {
    return null;
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(MEETING_END_SUMMARY_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!raw) {
    return null;
  }

  const envelope = parseMeetingEndSummaryEnvelope(raw);
  if (!envelope) {
    clearStoredMeetingEndSummary(storage);
    return null;
  }

  const nowMs = options.nowMs ?? Date.now();
  if (envelope.expiresAtMs <= nowMs) {
    clearStoredMeetingEndSummary(storage);
    return null;
  }

  if (options.roomId && envelope.summary.roomId !== options.roomId) {
    return null;
  }

  return envelope.summary;
}

export function consumeMeetingEndSummary(options: ReadMeetingEndSummaryOptions = {}): MeetingEndSummary | null {
  const storage = resolveStorage(options.storage);
  const summary = readMeetingEndSummary({
    ...options,
    storage: storage ?? undefined,
  });

  if (summary && storage) {
    clearStoredMeetingEndSummary(storage);
  }

  return summary;
}
