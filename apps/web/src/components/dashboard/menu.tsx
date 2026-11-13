import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Icon, type IconName } from "../site/Icon";
import { useOutsidePress } from "./use-outside-press";

/* ---------- popover menus: arrow keys move, Esc closes and returns focus ---------- */

type MenuProps = {
  readonly label: string;
  readonly trigger?: (props: { readonly open: boolean; readonly toggle: () => void }) => ReactNode;
  readonly icon?: IconName;
  readonly align?: "left";
  readonly children: (close: () => void) => ReactNode;
};

export function Menu({ label, trigger, icon = "more", align, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Focus goes back to the trigger first, so a dialog opened from the menu returns focus there too.
  const close = useCallback(() => {
    wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]")?.focus();
    setOpen(false);
  }, []);
  useOutsidePress(open, wrap, () => setOpen(false));
  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLElement>("[role=menu] [role^=menuitem]")?.focus();
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (!open) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]")?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>("[role=menu] [role^=menuitem]") ?? []);
    const at = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
    event.preventDefault();
  }

  const toggle = () => setOpen((value) => !value);
  return (
    <span className="mw" ref={wrap} onKeyDown={onKeyDown}>
      {trigger ? (
        trigger({ open, toggle })
      ) : (
        <button type="button" className="ib" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} data-tip onClick={toggle}>
          <Icon name={icon} />
        </button>
      )}
      {open ? (
        <div className={align ? "menu left" : "menu"} role="menu" id={id} aria-label={label}>
          {children(close)}
        </div>
      ) : null}
    </span>
  );
}

export function MenuItem({ icon, danger, onSelect, children }: { readonly icon?: IconName; readonly danger?: boolean; readonly onSelect: () => void; readonly children: ReactNode }) {
  return (
    <button type="button" className={danger ? "mi dg" : "mi"} role="menuitem" onClick={onSelect}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

/** The rename and archive entries every call menu ends with. */
export function RenameArchiveItems({ close, onRename, onArchive }: { readonly close: () => void; readonly onRename: () => void; readonly onArchive: () => void }) {
  return (
    <>
      <MenuItem
        icon="edit"
        onSelect={() => {
          close();
          onRename();
        }}
      >
        Rename
      </MenuItem>
      <div className="msep" />
      <MenuItem
        icon="trash"
        danger
        onSelect={() => {
          close();
          onArchive();
        }}
      >
        Archive call
      </MenuItem>
    </>
  );
}
