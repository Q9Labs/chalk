import type { TranscriptLanguage, WhisperLanguage } from "@chalk/transcript-language";
import { asWhisper } from "./transcript-languages";

/** What this device remembers about languages, and what the next new call starts with. */

const RECENT_SLOT = "chalk.transcript-language.recent";
const NEW_CALL_SLOT = "chalk.transcript-language.new-call";
const RECENT_LIMIT = 3;

function readStored(slot: string): string | null {
  try {
    return window.localStorage.getItem(slot);
  } catch {
    // Storage can be blocked (private windows, strict settings); the picker then starts fresh each time.
    return null;
  }
}

function writeStored(slot: string, value: string) {
  try {
    window.localStorage.setItem(slot, value);
  } catch {
    // Same as above: a choice that can't be kept still works for this visit.
  }
}

export function readRecentLanguages(): readonly WhisperLanguage[] {
  const raw = readStored(RECENT_SLOT);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => (typeof item === "string" ? (asWhisper(item) ?? []) : [])).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function rememberLanguage(code: WhisperLanguage) {
  writeStored(RECENT_SLOT, JSON.stringify([code, ...readRecentLanguages().filter((item) => item !== code)].slice(0, RECENT_LIMIT)));
}

/** What the next new call uses: null means the account default. */
export type NewCallLanguage = TranscriptLanguage | null;

export function readNewCallLanguage(): NewCallLanguage {
  const raw = readStored(NEW_CALL_SLOT);
  if (raw === "auto") return "auto";
  return raw ? asWhisper(raw) : null;
}

/** The request that starts a call: the account default when no language is chosen, else the chosen one. */
export function createCallAction(idempotencyKey: string, language: NewCallLanguage) {
  return { action: "create-call", admission: "knock", ...(language ? { transcriptLanguage: language } : {}), idempotencyKey } as const;
}

export function saveNewCallLanguage(value: NewCallLanguage) {
  writeStored(NEW_CALL_SLOT, value ?? "default");
}
