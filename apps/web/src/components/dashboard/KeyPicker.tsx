import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import type { KeyDTO } from "../../lib/dashboard/contracts";
import { Icon } from "../site/Icon";
import { publicPrefix } from "./developer-snippets";
import { useOutsidePress } from "./use-outside-press";

type MenuKeys = { count: number; active: number; setActive: (change: (value: number) => number) => void; choose: () => void; close: () => void; dismiss: () => void };

/** A listbox's keys: arrows wrap, Home and End jump, Enter and Space choose, Escape closes with focus back, Tab leaves. */
function menuKey(event: KeyboardEvent<HTMLDivElement>, { count, setActive, choose, close, dismiss }: MenuKeys) {
  switch (event.key) {
    case "ArrowDown":
      setActive((value) => (value + 1) % count);
      break;
    case "ArrowUp":
      setActive((value) => (value - 1 + count) % count);
      break;
    case "Home":
      setActive(() => 0);
      break;
    case "End":
      setActive(() => count - 1);
      break;
    case "Enter":
    case " ":
      choose();
      break;
    case "Escape":
      close();
      break;
    case "Tab":
      dismiss();
      return;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
}

type KeyOptionProps = { id: string; item: KeyDTO; chosen: boolean; highlighted: boolean; onHover: () => void; onChoose: () => void };

function KeyOption({ id, item, chosen, highlighted, onHover, onChoose }: KeyOptionProps) {
  return (
    <div id={id} role="option" aria-selected={chosen} className={highlighted ? "o hl" : "o"} onPointerEnter={onHover} onClick={onChoose}>
      {chosen ? <Icon name="check" size={16} className="ck" /> : <span className="ph0" />}
      <span className="kn">{item.name}</span>
      <span className="kp mono">{publicPrefix(item.prefix)}…</span>
    </div>
  );
}

function CreateKeyOption({ id, highlighted, onHover, onChoose }: { id: string; highlighted: boolean; onHover: () => void; onChoose: () => void }) {
  return (
    <div id={id} role="option" aria-selected={false} className={highlighted ? "o act hl" : "o act"} onPointerEnter={onHover} onClick={onChoose}>
      <Icon name="plus" size={16} />
      <span>Create API key</span>
    </div>
  );
}

function NoKeys() {
  return (
    <div>
      <div className="lbl">
        <Icon name="key" size={14} />
        API key
      </div>
      <button type="button" className="fld pick" disabled>
        <span className="mu" style={{ flex: 1 }}>
          No keys yet
        </span>
      </button>
    </div>
  );
}

export function KeyPicker({ keys, selected, onPick, onCreateKey }: { readonly keys: readonly KeyDTO[]; readonly selected: KeyDTO | null; readonly onPick: (id: string) => void; readonly onCreateKey: () => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const labelId = `${id}-label`;
  const count = keys.length + 1;

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);
  useOutsidePress(open, wrap, () => setOpen(false));

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function choose(index: number) {
    const chosen = keys[index];
    if (chosen) onPick(chosen.id);
    close();
    if (!chosen) onCreateKey();
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => menuKey(event, { count, active, setActive, choose: () => choose(active), close, dismiss: () => setOpen(false) });

  if (!selected) return <NoKeys />;

  return (
    <div className="pickw" ref={wrap}>
      <div className="lbl" id={labelId}>
        <Icon name="key" size={14} />
        API key
      </div>
      <button
        ref={trigger}
        type="button"
        className="fld pick"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => {
          setActive(Math.max(0, keys.indexOf(selected)));
          setOpen((value) => !value);
        }}
      >
        <span className="kn ell">{selected.name}</span>
        <span className="kp mono">{publicPrefix(selected.prefix)}…</span>
        <Icon name="down" size={16} />
      </button>
      {open ? (
        <div className="pmenu" role="listbox" ref={list} tabIndex={-1} aria-labelledby={labelId} aria-activedescendant={`${id}-${active}`} onKeyDown={onKeyDown}>
          {keys.map((item, index) => (
            <KeyOption key={item.id} id={`${id}-${index}`} item={item} chosen={item.id === selected.id} highlighted={index === active} onHover={() => setActive(index)} onChoose={() => choose(index)} />
          ))}
          <hr />
          <CreateKeyOption id={`${id}-${keys.length}`} highlighted={active === keys.length} onHover={() => setActive(keys.length)} onChoose={() => choose(keys.length)} />
        </div>
      ) : null}
    </div>
  );
}
