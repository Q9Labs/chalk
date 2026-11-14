import { type ReactNode } from "react";
import { type TranscriptLanguage } from "@chalk/transcript-language";
import { Icon, type IconName } from "../site/Icon";
import { readRecentLanguages } from "./language-choice";
import { languageByCode, languageOptions, searchLanguages, splitMatch, suggestedLanguages, type LanguageOption } from "./transcript-languages";

/** What a row stands for. `null` is "use the account default". */
export type Choice = TranscriptLanguage | null;
export type Row = { readonly key: string; readonly choice: Choice; readonly option: LanguageOption | null; readonly note?: string };
export type Section = { readonly title: string | null; readonly rows: readonly Row[] };

export const AUTOMATIC: readonly { readonly choice: Choice; readonly title: string; readonly note: string; readonly icon: IconName }[] = [
  { choice: null, title: "Use account default", note: "The language set for your account", icon: "home" },
  { choice: "auto", title: "Auto-detect", note: "Chalk picks the language it hears", icon: "globe" },
];

function languageRow(prefix: string, option: LanguageOption): Row {
  return { key: `${prefix}-${option.code}`, choice: option.code, option };
}

export function sectionsFor(query: string, allowDefault: boolean): readonly Section[] {
  if (query.trim()) {
    const hits = searchLanguages(query);
    const best = hits.filter((hit) => hit.rank === "best").map((hit) => languageRow("best", hit.option));
    const contains = hits.filter((hit) => hit.rank === "contains").map((hit) => languageRow("contains", hit.option));
    return [
      { title: best.length ? "Best match" : null, rows: best },
      { title: contains.length ? (best.length ? "Also contains" : "Contains") : null, rows: contains },
    ].filter((section) => section.rows.length > 0);
  }
  const recent = readRecentLanguages();
  const suggested = suggestedLanguages(recent);
  return [
    {
      title: "Automatic",
      rows: AUTOMATIC.filter((item) => allowDefault || item.choice !== null).map((item) => ({ key: `auto-${item.choice ?? "default"}`, choice: item.choice, option: null, note: item.note })),
    },
    { title: recent.length ? "Recent" : null, rows: recent.map((code) => languageRow("recent", languageByCode(code))) },
    { title: suggested.length ? "Suggested" : null, rows: suggested.map((code) => languageRow("suggested", languageByCode(code))) },
    { title: "All languages", rows: languageOptions.map((option) => languageRow("all", option)) },
  ].filter((section) => section.rows.length > 0);
}

function Slot({ children }: { readonly children: ReactNode }) {
  return (
    <span className="lp-slot" aria-hidden="true">
      {children}
    </span>
  );
}

export function Flag({ option }: { readonly option: LanguageOption }) {
  // The drawn flag is a hint, so it has no text of its own: the name beside it says the language.
  return <Slot>{option.flag ? <img className="lp-flag" src={option.flag} alt="" width={20} height={14} loading="lazy" /> : <span className="lp-code">{option.code}</span>}</Slot>;
}

export function Mark({ text, query }: { readonly text: string; readonly query: string }) {
  const [before, match, after] = splitMatch(text, query);
  return match ? (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  ) : (
    text
  );
}

/** An icon for a choice that is not a language. It sits bare in the slot: a box around it would read as a flag. */
export function Glyph({ icon }: { readonly icon: IconName }) {
  return (
    <Slot>
      <Icon name={icon} size={18} />
    </Slot>
  );
}

export function rowTitle(row: Row): string {
  if (row.option) return row.option.name;
  return AUTOMATIC.find((item) => item.choice === row.choice)?.title ?? "";
}

/** What the closed control shows for a value. */
export function Current({ value }: { readonly value: Choice }) {
  if (value === null)
    return (
      <>
        <Glyph icon="home" />
        <span className="lp-name">Use account default</span>
      </>
    );
  if (value === "auto")
    return (
      <>
        <Glyph icon="globe" />
        <span className="lp-name">Auto-detect</span>
      </>
    );
  const option = languageByCode(value);
  return (
    <>
      <Flag option={option} />
      <span className="lp-name">{option.name}</span>
      {option.native ? (
        <span className="lp-native" lang={option.code} dir="auto">
          {option.native}
        </span>
      ) : null}
    </>
  );
}
