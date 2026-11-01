// Whisper v3 primary codes; the API contract parity test prevents allowlist drift.
export const whisperLanguages = {
  af: "afrikaans",
  am: "amharic",
  ar: "arabic",
  as: "assamese",
  az: "azerbaijani",
  ba: "bashkir",
  be: "belarusian",
  bg: "bulgarian",
  bn: "bengali",
  bo: "tibetan",
  br: "breton",
  bs: "bosnian",
  ca: "catalan",
  cs: "czech",
  cy: "welsh",
  da: "danish",
  de: "german",
  el: "greek",
  en: "english",
  es: "spanish",
  et: "estonian",
  eu: "basque",
  fa: "persian",
  fi: "finnish",
  fo: "faroese",
  fr: "french",
  gl: "galician",
  gu: "gujarati",
  ha: "hausa",
  haw: "hawaiian",
  he: "hebrew",
  hi: "hindi",
  hr: "croatian",
  ht: "haitian creole",
  hu: "hungarian",
  hy: "armenian",
  id: "indonesian",
  is: "icelandic",
  it: "italian",
  ja: "japanese",
  jw: "javanese",
  ka: "georgian",
  kk: "kazakh",
  km: "khmer",
  kn: "kannada",
  ko: "korean",
  la: "latin",
  lb: "luxembourgish",
  ln: "lingala",
  lo: "lao",
  lt: "lithuanian",
  lv: "latvian",
  mg: "malagasy",
  mi: "maori",
  mk: "macedonian",
  ml: "malayalam",
  mn: "mongolian",
  mr: "marathi",
  ms: "malay",
  mt: "maltese",
  my: "myanmar",
  ne: "nepali",
  nl: "dutch",
  nn: "nynorsk",
  no: "norwegian",
  oc: "occitan",
  pa: "punjabi",
  pl: "polish",
  ps: "pashto",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sa: "sanskrit",
  sd: "sindhi",
  si: "sinhala",
  sk: "slovak",
  sl: "slovenian",
  sn: "shona",
  so: "somali",
  sq: "albanian",
  sr: "serbian",
  su: "sundanese",
  sv: "swedish",
  sw: "swahili",
  ta: "tamil",
  te: "telugu",
  tg: "tajik",
  th: "thai",
  tk: "turkmen",
  tl: "tagalog",
  tr: "turkish",
  tt: "tatar",
  uk: "ukrainian",
  ur: "urdu",
  uz: "uzbek",
  vi: "vietnamese",
  yi: "yiddish",
  yo: "yoruba",
  yue: "cantonese",
  zh: "chinese",
} as const;
export type WhisperLanguage = keyof typeof whisperLanguages;
export type TranscriptLanguage = "auto" | WhisperLanguage;
export type TranscriptLanguageMode = { readonly mode: "auto" } | { readonly mode: "fixed"; readonly language: WhisperLanguage };
export function parseTranscriptLanguage(value: unknown): TranscriptLanguageMode {
  if (value === "auto") return { mode: "auto" };
  if (typeof value === "string" && Object.hasOwn(whisperLanguages, value)) return { mode: "fixed", language: value as WhisperLanguage };
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
