import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref, type RefObject } from "react";
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

/** The popover opens below the control from its left edge. It uses the right edge when the left would push it past the screen, and opens upward when it would run off the bottom and there is more room above. */
function usePlacement(open: boolean, wrap: RefObject<HTMLDivElement | null>) {
  const [alignEnd, setAlignEnd] = useState(false);
  const [opensUp, setOpensUp] = useState(false);
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const popover = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * SCREEN_MARGIN);
    const box = wrap.current.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - SCREEN_MARGIN;
    setAlignEnd(box.left + popover > window.innerWidth - SCREEN_MARGIN);
    setOpensUp(below < POPOVER_HEIGHT && box.top > below);
  }, [open, wrap]);
  return { alignEnd, opensUp };
}

function useOutsidePress(open: boolean, wrap: RefObject<HTMLDivElement | null>, onOutside: () => void) {
  const latest = useRef(onOutside);
  latest.current = onOutside;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) latest.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, wrap]);
}

type SearchKeys = {
  rows: readonly { choice: Choice }[];
  active: number;
  query: string;
  setActive: (change: (at: number) => number) => void;
  choose: (choice: Choice) => void;
  close: () => void;
};

/** Arrows move, Home and End jump (unless the user is typing a query), Enter chooses, Esc closes. */
function searchKey(event: KeyboardEvent<HTMLInputElement>, { rows, active, query, setActive, choose, close }: SearchKeys) {
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
      setActive(() => 0);
      break;
    case "End":
      if (query) return;
      setActive(() => last);
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

type PickerTriggerProps = {
  readonly ref: Ref<HTMLButtonElement>;
  readonly id: string;
  readonly value: Choice;
  readonly variant: "field" | "chip";
  readonly open: boolean;
  readonly listId: string;
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly loading: boolean;
  readonly loadingLabel: string;
  readonly inactive: boolean;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
};

function PickerTrigger({ ref, id, value, variant, open, listId, labelledBy, describedBy, loading, loadingLabel, inactive, onToggle, onOpen }: PickerTriggerProps) {
  return (
    <button
      ref={ref}
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
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" || inactive) return;
        event.preventDefault();
        onOpen();
      }}
    >
      {loading ? <span className="spin" aria-hidden="true" /> : <Current value={value} />}
      {loading ? <span className="lp-name">{loadingLabel}</span> : null}
      <Icon name="down" size={16} className="lp-chev" />
    </button>
  );
}

/** A press on a row or button must not pull focus off the search box, or the list would close; a press on the box itself must still focus it. */
function keepFocusInSearch(event: MouseEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
}

type PickerPopoverProps = { readonly phone: boolean; readonly alignEnd: boolean; readonly opensUp: boolean; readonly onDismiss: () => void; readonly children: ReactNode };

function PickerPopover({ phone, alignEnd, opensUp, onDismiss, children }: PickerPopoverProps) {
  if (!phone) {
    return (
      <div className={`lp-pop${alignEnd ? " end" : ""}${opensUp ? " up" : ""}`} role="dialog" aria-label="Transcript language" onMouseDown={keepFocusInSearch}>
        {children}
      </div>
    );
  }
  return (
    <div className="scrim" onPointerDown={(event) => event.target === event.currentTarget && onDismiss()}>
      <div className="lp-pop sheet" role="dialog" aria-label="Transcript language" onMouseDown={keepFocusInSearch}>
        <span className="lp-grab" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

/** A searchable list of the languages the transcriber supports, with a flag beside each. Arrow keys move, Enter chooses, Esc closes; a phone gets a bottom sheet. */
export function LanguagePicker({ id, value, onChange, allowDefault = false, disabled = false, loading = false, loadingLabel = "Loading…", variant = "field", describedBy, labelledBy }: LanguagePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const { alignEnd, opensUp } = usePlacement(open, wrap);
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
  }, [open]);
  useOutsidePress(open, wrap, () => close(false));

  // A new search starts at its best match; opening starts on the chosen language.
  useEffect(() => {
    if (!open) return;
    const selected = query.trim() ? -1 : rows.findIndex((row) => row.choice === value);
    setActive(Math.max(selected, 0));
  }, [open, query]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => searchKey(event, { rows, active, query, setActive, choose, close });

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
      <PickerTrigger ref={trigger} id={id} value={value} variant={variant} open={open} listId={listId} labelledBy={labelledBy} describedBy={describedBy} loading={loading} loadingLabel={loadingLabel} inactive={inactive} onToggle={() => (open ? close() : setOpen(true))} onOpen={() => setOpen(true)} />
      {open ? (
        <PickerPopover phone={phone} alignEnd={alignEnd} opensUp={opensUp} onDismiss={() => close()}>
          {list}
        </PickerPopover>
      ) : null}
    </div>
  );
}
