// Whisper v3 primary codes; the API contract parity test prevents allowlist drift.
export const whisperLanguageCodes = [
  "af",
  "am",
  "ar",
  "as",
  "az",
  "ba",
  "be",
  "bg",
  "bn",
  "bo",
  "br",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fo",
  "fr",
  "gl",
  "gu",
  "ha",
  "haw",
  "he",
  "hi",
  "hr",
  "ht",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "jw",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "la",
  "lb",
  "ln",
  "lo",
  "lt",
  "lv",
  "mg",
  "mi",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "mt",
  "my",
  "ne",
  "nl",
  "nn",
  "no",
  "oc",
  "pa",
  "pl",
  "ps",
  "pt",
  "ro",
  "ru",
  "sa",
  "sd",
  "si",
  "sk",
  "sl",
  "sn",
  "so",
  "sq",
  "sr",
  "su",
  "sv",
  "sw",
  "ta",
  "te",
  "tg",
  "th",
  "tk",
  "tl",
  "tr",
  "tt",
  "uk",
  "ur",
  "uz",
  "vi",
  "yi",
  "yo",
  "yue",
  "zh",
] as const;
export type WhisperLanguage = (typeof whisperLanguageCodes)[number];
export type TranscriptLanguage = "auto" | WhisperLanguage;
export type TranscriptLanguageMode = { readonly mode: "auto" } | { readonly mode: "fixed"; readonly language: WhisperLanguage };
export function parseTranscriptLanguage(value: unknown): TranscriptLanguageMode {
  if (value === "auto") return { mode: "auto" };
  if (typeof value === "string" && whisperLanguageCodes.some((code) => code === value)) return { mode: "fixed", language: value as WhisperLanguage };
  throw new Error("Invalid transcript language");
}
export function transcriptLanguageValue(mode: TranscriptLanguageMode): TranscriptLanguage {
  return mode.mode === "auto" ? "auto" : mode.language;
}

export function parseTranscriptLanguageMode(value: unknown): TranscriptLanguageMode {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid transcript language mode");
  if (!("mode" in value)) throw new Error("Invalid transcript language mode");
  if (value.mode === "auto" && !("language" in value)) return { mode: "auto" };
  if (value.mode === "fixed" && "language" in value) {
    const parsed = parseTranscriptLanguage(value.language);
    if (parsed.mode === "fixed") return parsed;
  }
  throw new Error("Invalid transcript language mode");
}
