import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "../site/Icon";
import { usePhone } from "./kit";
import { Current, sectionsFor, type Choice } from "./language-rows";
import { LanguageList } from "./LanguageList";

const POPOVER_WIDTH = 352;
const SCREEN_MARGIN = 16;
const POPOVER_HEIGHT = 400;

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

  const list = <LanguageList query={query} setQuery={setQuery} sections={sections} rows={rows} active={active} setActive={setActive} value={value} choose={choose} onKeyDown={onKeyDown} search={search} listId={listId} statusId={statusId} />;

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
