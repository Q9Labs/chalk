import { AssignmentError } from "./errors.js";

export function row(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

export function exactRow(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const valueRow = row(value, label);
  const expected = new Set(keys);
  if (Object.keys(valueRow).length !== expected.size || Object.keys(valueRow).some((key) => !expected.has(key))) throw new AssignmentError(`${label} fields are invalid`);
  return valueRow;
}

export function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AssignmentError(`${label} is invalid`);
  return value;
}

export function optionalText(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length > max) throw new AssignmentError(`${label} is invalid`);
  return value;
}

export function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new AssignmentError(`${label} is invalid`);
  return value;
}

export function integer(value: unknown, label: string): number {
  const number = nonnegative(value, label);
  if (!Number.isInteger(number)) throw new AssignmentError(`${label} is invalid`);
  return number;
}

export function positiveInteger(value: unknown, label: string): number {
  const number = integer(value, label);
  if (number < 1 || !Number.isSafeInteger(number)) throw new AssignmentError(`${label} is invalid`);
  return number;
}

export function literal<const Expected extends string>(value: unknown, expected: Expected, label: string): Expected {
  if (value !== expected) throw new AssignmentError(`${label} is invalid`);
  return expected;
}

export function checksum(value: unknown, label: string): string {
  const digest = text(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new AssignmentError(`${label} is invalid`);
  return digest;
}

export function expiringUrl(value: unknown, label: string, maxTtlMs: number): string {
  const urlText = text(value, label, 4_096);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new AssignmentError(`${label} is invalid`);
  }
  if (url.protocol !== "https:") throw new AssignmentError(`${label} must use HTTPS`);
  const expiryRaw = url.searchParams.get("X-Amz-Expires") ?? url.searchParams.get("expires");
  const dateRaw = url.searchParams.get("X-Amz-Date");
  if (!expiryRaw || !/^\d+$/.test(expiryRaw)) throw new AssignmentError(`${label} has no short-lived expiry`);
  const expirySeconds = Number(expiryRaw);
  if (!Number.isInteger(expirySeconds) || expirySeconds < 1 || expirySeconds * 1_000 > maxTtlMs) {
    throw new AssignmentError(`${label} exceeds short-lived TTL`);
  }
  if (dateRaw) {
    const date = /^\d{8}T\d{6}Z$/.test(dateRaw) ? Date.UTC(Number(dateRaw.slice(0, 4)), Number(dateRaw.slice(4, 6)) - 1, Number(dateRaw.slice(6, 8)), Number(dateRaw.slice(9, 11)), Number(dateRaw.slice(11, 13)), Number(dateRaw.slice(13, 15))) : Number.NaN;
    if (!Number.isFinite(date)) throw new AssignmentError(`${label} signing date is invalid`);
    if (date + expirySeconds * 1_000 < Date.now() - 60_000) throw new AssignmentError(`${label} is expired`);
  }
  return url.toString();
}

export function isoTimestamp(value: unknown, label: string): string {
  const date = text(value, label, 64);
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) throw new AssignmentError(`${label} is invalid`);
  return date;
}

export function isoDate(value: unknown, label: string): string {
  const date = isoTimestamp(value, label);
  if (Date.parse(date) < Date.now() - 60_000) throw new AssignmentError(`${label} is expired`);
  return date;
}
