import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { whisperLanguageCodes, type TranscriptLanguage } from "@chalk/transcript-language";
import { Icon, type IconName } from "../site/Icon";
import { usePhone } from "./kit";
import { languageByCode, languageOptions, readRecentLanguages, searchLanguages, splitMatch, suggestedLanguages, type LanguageOption } from "./transcript-languages";

const POPOVER_WIDTH = 352;
const SCREEN_MARGIN = 16;
const POPOVER_HEIGHT = 400;

/** What a row stands for. `null` is "use the account default". */
type Choice = TranscriptLanguage | null;

type Row = { readonly key: string; readonly choice: Choice; readonly option: LanguageOption | null; readonly note?: string };
type Section = { readonly title: string | null; readonly rows: readonly Row[] };

const AUTOMATIC: readonly { readonly choice: Choice; readonly title: string; readonly note: string; readonly icon: IconName }[] = [
  { choice: null, title: "Use account default", note: "The language set for your account", icon: "home" },
  { choice: "auto", title: "Auto-detect", note: "Chalk picks the language it hears", icon: "globe" },
];

function languageRow(prefix: string, option: LanguageOption): Row {
  return { key: `${prefix}-${option.code}`, choice: option.code, option };
}

function sectionsFor(query: string, allowDefault: boolean): readonly Section[] {
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

function Flag({ option }: { readonly option: LanguageOption }) {
  // The drawn flag is a hint, so it has no text of its own: the name beside it says the language.
  return <Slot>{option.flag ? <img className="lp-flag" src={option.flag} alt="" width={20} height={14} loading="lazy" /> : <span className="lp-code">{option.code}</span>}</Slot>;
}

function Mark({ text, query }: { readonly text: string; readonly query: string }) {
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
function Glyph({ icon }: { readonly icon: IconName }) {
  return (
    <Slot>
      <Icon name={icon} size={18} />
    </Slot>
  );
}

function rowTitle(row: Row): string {
  if (row.option) return row.option.name;
  return AUTOMATIC.find((item) => item.choice === row.choice)?.title ?? "";
}

/** What the closed control shows for a value. */
function Current({ value }: { readonly value: Choice }) {
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

export type LanguagePickerProps = {
  readonly id: string;
  readonly value: Choice;
  readonly onChange: (value: Choice) => void;
  /** Adds the "Use account default" row, for a setting that can inherit. */
  readonly allowDefault?: boolean;
  readonly disabled?: boolean;
  /** The value is being saved or fetched: the control shows progress and can't be opened. */
  readonly loading?: boolean;
  /** `chip` is the small pill beside a button; `field` is a form field. */
  readonly variant?: "field" | "chip";
  readonly describedBy?: string;
  readonly loadingLabel?: string;
  /** The id of the text that names this control. The current language is read after it. */
  readonly labelledBy: string;
};

/** A searchable list of the languages the transcriber supports, with a flag beside each. Arrow keys move, Enter chooses, Esc closes; a phone gets a bottom sheet. */
export function LanguagePicker({ id, value, onChange, allowDefault = false, disabled = false, loading = false, loadingLabel = "Loading…", variant = "field", describedBy, labelledBy }: LanguagePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [alignEnd, setAlignEnd] = useState(false);
  const [opensUp, setOpensUp] = useState(false);
  const phone = usePhone();
  const listId = useId();
  const statusId = useId();

  const sections = useMemo(() => (open ? sectionsFor(query, allowDefault) : []), [open, query, allowDefault]);
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const inactive = disabled || loading;

  function close(restoreFocus = true) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
  }

  function choose(choice: Choice) {
    close();
    if (choice !== value) onChange(choice);
  }

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  // The popover opens below the control from its left edge. It uses the right edge when the left would push it past the screen, and opens upward when it would run off the bottom and there is more room above.
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const popover = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * SCREEN_MARGIN);
    const box = wrap.current.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - SCREEN_MARGIN;
    setAlignEnd(box.left + popover > window.innerWidth - SCREEN_MARGIN);
    setOpensUp(below < POPOVER_HEIGHT && box.top > below);
  }, [open]);

  // A new search starts at its best match; opening starts on the chosen language.
  useEffect(() => {
    if (!open) return;
    const selected = query.trim() ? -1 : rows.findIndex((row) => row.choice === value);
    setActive(Math.max(selected, 0));
  }, [open, query]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter and the arrows belong to the input method while it composes text.
    if (event.nativeEvent.isComposing) return;
    const last = rows.length - 1;
    switch (event.key) {
      case "ArrowDown":
        setActive((at) => Math.min(at + 1, last));
        break;
      case "ArrowUp":
        setActive((at) => Math.max(at - 1, 0));
        break;
      case "Home":
        if (query) return;
        setActive(0);
        break;
      case "End":
        if (query) return;
        setActive(last);
        break;
      case "Enter": {
        const row = rows[active];
        if (row) choose(row.choice);
        break;
      }
      case "Escape":
        event.stopPropagation();
        close();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  // A press on a row or button must not pull focus off the search box, or the list would close; a press on the box itself must still focus it.
  function keepFocusInSearch(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  }

  let at = -1;
  const list: ReactNode = (
    <>
      <div className="lp-search">
        <Icon name="search" size={18} />
        <input
          ref={search}
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Search languages"
          placeholder="Search by name, native name or code"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {!query ? <kbd aria-hidden="true">Esc</kbd> : null}
        {query && rows.length ? (
          <button
            type="button"
            className="ib"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              search.current?.focus();
            }}
          >
            <Icon name="x" size={16} />
          </button>
        ) : null}
      </div>
      <p className="lp-status" id={statusId} role="status">
        {query.trim() ? (rows.length ? `${rows.length} ${rows.length === 1 ? "language" : "languages"}` : "No languages match") : ""}
      </p>
      {rows.length ? (
        <div className="lp-list" role="listbox" id={listId} aria-label="Languages">
          {sections.map((section) => (
            <div key={section.title ?? "rows"} role="group" aria-label={section.title ?? undefined}>
              {section.title ? (
                <div className="lp-head" aria-hidden="true">
                  {section.title}
                </div>
              ) : null}
              {section.rows.map((row) => {
                at += 1;
                const index = at;
                const selected = row.choice === value;
                const automatic = AUTOMATIC.find((item) => item.choice === row.choice);
                return (
                  <div key={row.key} id={`${listId}-${index}`} role="option" aria-selected={selected} className={`lp-opt${index === active ? " on" : ""}${selected ? " sel" : ""}`} onPointerMove={() => setActive(index)} onClick={() => choose(row.choice)}>
                    {row.option ? <Flag option={row.option} /> : <Glyph icon={automatic?.icon ?? "globe"} />}
                    <span className="lp-text">
                      <span className="lp-name">{row.option ? <Mark text={row.option.name} query={query} /> : rowTitle(row)}</span>
                      {row.note ? <small>{row.note}</small> : null}
                    </span>
                    {row.option?.native ? (
                      <span className="lp-native" lang={row.option.code} dir="auto">
                        <Mark text={row.option.native} query={query} />
                      </span>
                    ) : null}
                    {selected ? <Icon name="check" size={16} className="lp-check" /> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="lp-none">
          <b>No language matches “{query.trim()}”</b>
          <p>Chalk lists the {whisperLanguageCodes.length} languages its transcriber supports. Check the spelling, or search by the language’s own name or code.</p>
          <div className="lp-acts">
            <button
              type="button"
              className="btn pri sm"
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
            >
              Clear search
            </button>
            <button type="button" className="btn sm" onClick={() => choose("auto")}>
              Use Auto-detect
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div
      className={`lp lp-${variant}`}
      ref={wrap}
      onBlur={(event) => {
        // Tab can move among the picker's own buttons; the list closes once focus leaves it.
        if (open && !(event.relatedTarget instanceof Node && wrap.current?.contains(event.relatedTarget))) close(false);
      }}
    >
      <button
        ref={trigger}
        id={id}
        type="button"
        className={variant === "chip" ? "btn sm lp-trigger" : "lp-trigger"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={describedBy}
        aria-labelledby={`${labelledBy} ${id}`}
        aria-busy={loading || undefined}
        disabled={inactive}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || inactive) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {loading ? <span className="spin" aria-hidden="true" /> : <Current value={value} />}
        {loading ? <span className="lp-name">{loadingLabel}</span> : null}
        <Icon name="down" size={16} className="lp-chev" />
      </button>
      {open ? (
        phone ? (
          <div className="scrim" onPointerDown={(event) => event.target === event.currentTarget && close()}>
            <div className="lp-pop sheet" role="dialog" aria-label="Transcript language" onMouseDown={keepFocusInSearch}>
              <span className="lp-grab" aria-hidden="true" />
              {list}
            </div>
          </div>
        ) : (
          <div className={`lp-pop${alignEnd ? " end" : ""}${opensUp ? " up" : ""}`} role="dialog" aria-label="Transcript language" onMouseDown={keepFocusInSearch}>
            {list}
          </div>
        )
      ) : null}
    </div>
  );
}
