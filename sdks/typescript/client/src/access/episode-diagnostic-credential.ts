import { decodeBase64Url } from "./base64-url";

const INTAKE_PATH = "/_internal/episode-diagnostic-events" as const;
const RFC3339_ZONED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type EpisodeDiagnosticCredential = Readonly<{
  token: string;
  expiresAt: string;
  generation: number;
  intakePath: typeof INTAKE_PATH;
}>;

export function parseEpisodeDiagnosticCredential(value: unknown): EpisodeDiagnosticCredential | null {
  if (!isRecord(value)) return null;
  const token = value.token;
  const expiresAt = value.expires_at;
  const generation = value.generation;
  const intakePath = value.intake_path;
  if (typeof token !== "string" || !validDiagnosticCredential(token)) return null;
  if (!isRFC3339Zoned(expiresAt)) return null;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) return null;
  if (intakePath !== INTAKE_PATH) return null;
  return Object.freeze({ token, expiresAt, generation: generation as number, intakePath });
}

export function validEpisodeDiagnosticCredential(credential: EpisodeDiagnosticCredential, now: number): boolean {
  return credential.intakePath === INTAKE_PATH && Number.isSafeInteger(credential.generation) && credential.generation > 0 && isRFC3339Zoned(credential.expiresAt) && Date.parse(credential.expiresAt) > now && validDiagnosticCredential(credential.token);
}

function validDiagnosticCredential(token: string): boolean {
  const segments = token.split(".");
  if (segments.length !== 3) return false;
  try {
    const payload = JSON.parse(decodeBase64Url(segments[1] ?? "")) as unknown;
    return isRecord(payload) && payload.aud === "chalk-diagnostics";
  } catch {
    return false;
  }
}

function isRFC3339Zoned(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_ZONED.exec(value);
  if (!match) return false;
  return validTimestampFields(match) && Number.isFinite(Date.parse(value));
}

function validTimestampFields(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7] ?? "";
  return validCalendarDate(year, month, day) && validClockTime(hour, minute, second) && validZoneOffset(zone);
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  return inRange(month, 1, 12) && inRange(day, 1, daysInMonth(year, month));
}

function validClockTime(hour: number, minute: number, second: number): boolean {
  return inRange(hour, 0, 23) && inRange(minute, 0, 59) && inRange(second, 0, 59);
}

function validZoneOffset(zone: string): boolean {
  if (zone === "Z") return true;
  return inRange(Number(zone.slice(1, 3)), 0, 23) && inRange(Number(zone.slice(4, 6)), 0, 59);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
