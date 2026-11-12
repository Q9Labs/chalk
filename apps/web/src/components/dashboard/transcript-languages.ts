import { whisperLanguageCodes, type TranscriptLanguage, type WhisperLanguage } from "@chalk/transcript-language";

/** The country whose flag stands for each language: the one with the most speakers, or the one that holds it as its own. Tibetan and Yiddish have none, so they show their code. */
const flagCountry: Record<WhisperLanguage, string | null> = {
  af: "ZA",
  am: "ET",
  ar: "SA",
  as: "IN",
  az: "AZ",
  ba: "RU",
  be: "BY",
  bg: "BG",
  bn: "BD",
  bo: null,
  br: "FR",
  bs: "BA",
  ca: "AD",
  cs: "CZ",
  cy: "GB",
  da: "DK",
  de: "DE",
  el: "GR",
  en: "GB",
  es: "ES",
  et: "EE",
  eu: "ES",
  fa: "IR",
  fi: "FI",
  fo: "FO",
  fr: "FR",
  gl: "ES",
  gu: "IN",
  ha: "NG",
  haw: "US",
  he: "IL",
  hi: "IN",
  hr: "HR",
  ht: "HT",
  hu: "HU",
  hy: "AM",
  id: "ID",
  is: "IS",
  it: "IT",
  ja: "JP",
  jw: "ID",
  ka: "GE",
  kk: "KZ",
  km: "KH",
  kn: "IN",
  ko: "KR",
  la: "VA",
  lb: "LU",
  ln: "CD",
  lo: "LA",
  lt: "LT",
  lv: "LV",
  mg: "MG",
  mi: "NZ",
  mk: "MK",
  ml: "IN",
  mn: "MN",
  mr: "IN",
  ms: "MY",
  mt: "MT",
  my: "MM",
  ne: "NP",
  nl: "NL",
  nn: "NO",
  no: "NO",
  oc: "FR",
  pa: "IN",
  pl: "PL",
  ps: "AF",
  pt: "PT",
  ro: "RO",
  ru: "RU",
  sa: "IN",
  sd: "PK",
  si: "LK",
  sk: "SK",
  sl: "SI",
  sn: "ZW",
  so: "SO",
  sq: "AL",
  sr: "RS",
  su: "ID",
  sv: "SE",
  sw: "TZ",
  ta: "IN",
  te: "IN",
  tg: "TJ",
  th: "TH",
  tk: "TM",
  tl: "PH",
  tr: "TR",
  tt: "RU",
  uk: "UA",
  ur: "PK",
  uz: "UZ",
  vi: "VN",
  yi: null,
  yo: "NG",
  yue: "HK",
  zh: "CN",
};

export type LanguageOption = {
  readonly code: WhisperLanguage;
  readonly name: string;
  /** The language's own name, or null when it is the same as `name`. */
  readonly native: string | null;
  /** Path of the flag drawing, or null when the row shows the code instead. */
  readonly flag: string | null;
  /** `name`, `native` and `code` folded for matching. */
  readonly haystack: readonly [name: string, native: string, code: string];
};

const english = new Intl.DisplayNames(["en"], { type: "language" });
// Intl knows Javanese only as "jv", the modern code; Whisper still says "jw".
const names: Partial<Record<WhisperLanguage, string>> = { jw: "Javanese" };

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

function option(code: WhisperLanguage): LanguageOption {
  const name = names[code] ?? english.of(code) ?? code;
  const own = new Intl.DisplayNames([code === "jw" ? "jv" : code], { type: "language" }).of(code === "jw" ? "jv" : code);
  const native = own && own !== name ? own : null;
  const country = flagCountry[code];
  return { code, name, native, flag: country ? `/flags/${country.toLowerCase()}.svg` : null, haystack: [fold(name), fold(native ?? ""), code] };
}

export const languageOptions: readonly LanguageOption[] = [...whisperLanguageCodes].map(option).sort((a, b) => a.name.localeCompare(b.name));

const byCode = new Map(languageOptions.map((item) => [item.code, item]));
export function languageByCode(code: WhisperLanguage): LanguageOption {
  const found = byCode.get(code);
  if (!found) throw new Error(`Unknown transcript language ${code}`);
  return found;
}

export function languageName(value: TranscriptLanguage): string {
  return value === "auto" ? "Auto-detect" : languageByCode(value).name;
}

export type SearchHit = { readonly option: LanguageOption; readonly rank: "best" | "contains" };

/** Names, native names and codes (from two letters) that start with the text come first; those that only contain it follow. */
export function searchLanguages(query: string): readonly SearchHit[] {
  const text = fold(query.trim());
  if (!text) return [];
  const best: SearchHit[] = [];
  const contains: SearchHit[] = [];
  for (const item of languageOptions) {
    const [name, native, code] = item.haystack;
    if (code === text || (text.length > 1 && code.startsWith(text)) || name.startsWith(text) || native.startsWith(text)) best.push({ option: item, rank: "best" });
    else if (name.includes(text) || native.includes(text)) contains.push({ option: item, rank: "contains" });
  }
  return [...best, ...contains];
}

/** The text of `text` split around the first place `query` matches it, so the match can be marked. */
export function splitMatch(text: string, query: string): readonly [before: string, match: string, after: string] {
  const needle = fold(query.trim());
  if (!needle) return [text, "", ""];
  // Folding only drops marks, so it keeps one character per letter in every supported name.
  const at = fold(text).indexOf(needle);
  if (at < 0) return [text, "", ""];
  return [text.slice(0, at), text.slice(at, at + needle.length), text.slice(at + needle.length)];
}

export function asWhisper(code: string): WhisperLanguage | null {
  return whisperLanguageCodes.find((item) => item === code) ?? null;
}

/** The browser's languages that the transcriber supports, then the languages most calls need, without those in `skip`. */
export function suggestedLanguages(skip: readonly WhisperLanguage[], browser: readonly string[] = navigator.languages): readonly WhisperLanguage[] {
  const fromBrowser = browser.flatMap((tag) => asWhisper(tag.split("-")[0]?.toLowerCase() ?? "") ?? []);
  return [...new Set([...fromBrowser, ...(["en", "ur", "ar", "hi"] as const)])].filter((code) => !skip.includes(code)).slice(0, 4);
}
