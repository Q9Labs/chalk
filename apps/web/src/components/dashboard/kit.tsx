import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { errorMessage } from "../../lib/dashboard/client";
import { trapDialogFocus } from "../docs/dialog-focus";
import { ChalkToast } from "@q9labsai/chalk-react";
import { Icon, type IconName } from "../site/Icon";

const PHONE = "(max-width: 640px)";

/** True on a phone-width screen, where rows and dialogs change shape, not only size. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (change) => {
      const query = window.matchMedia(PHONE);
      query.addEventListener("change", change);
      return () => query.removeEventListener("change", change);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

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
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>("[role=menu] [role^=menuitem]")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
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

/* ---------- dialogs: a card on a scrim, a bottom sheet on the phone ---------- */

type DialogProps = {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly alert?: boolean;
  readonly wide?: boolean;
  readonly onClose: () => void;
  readonly onSubmit?: () => void;
  readonly children?: ReactNode;
  readonly actions: ReactNode;
};

/** Traps focus, closes on Esc or the scrim, and gives focus back to whatever opened it. */
export function Dialog({ title, description, alert, wide, onClose, onSubmit, children, actions }: DialogProps) {
  const card = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = card.current?.querySelector<HTMLElement>("[autofocus], input:not([type=checkbox]), .acts .btn:last-child");
    first?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    trapDialogFocus(event);
  }

  const inner = (
    <>
      <button type="button" className="ib x" aria-label="Close" onClick={onClose}>
        <Icon name="x" />
      </button>
      <h2 id={titleId}>{title}</h2>
      {description ? <p id={descriptionId}>{description}</p> : null}
      {children}
      <div className="acts">{actions}</div>
    </>
  );
  const shared = {
    className: wide ? "dlg w" : "dlg",
    role: alert ? "alertdialog" : "dialog",
    "aria-modal": true,
    "aria-labelledby": titleId,
    "aria-describedby": description ? descriptionId : undefined,
    onKeyDown,
  } as const;
  return (
    <div
      className="scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {onSubmit ? (
        <form
          {...shared}
          ref={(node) => {
            card.current = node;
          }}
          noValidate
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {inner}
        </form>
      ) : (
        <div
          {...shared}
          ref={(node) => {
            card.current = node;
          }}
        >
          {inner}
        </div>
      )}
    </div>
  );
}

/* ---------- idempotency: one key per user intent, kept until it succeeds ---------- */

/** `key(intent)` returns the same key until `done(intent)`, so a retry after a failure replays the same request. */
export function useIntentKeys() {
  const keys = useRef(new Map<string, string>());
  const key = useCallback((intent: string) => {
    const existing = keys.current.get(intent);
    if (existing) return existing;
    const created = crypto.randomUUID();
    keys.current.set(intent, created);
    return created;
  }, []);
  const done = useCallback((intent: string) => void keys.current.delete(intent), []);
  return { key, done };
}

/* ---------- the next page of a list ---------- */

export function MoreButton<T>({ label, cursor, load, onLoaded }: { readonly label: string; readonly cursor: string; readonly load: (cursor: string) => Promise<T>; readonly onLoaded: (page: T) => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <div className="more-row">
      <button
        type="button"
        className="btn sec sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          load(cursor)
            .then(onLoaded, (error: unknown) => toast(errorMessage(error), { icon: "alert" }))
            .finally(() => setBusy(false));
        }}
      >
        {label}
      </button>
    </div>
  );
}

/* ---------- toasts ---------- */

type Toast = { readonly id: number; readonly message: string; readonly icon: IconName; readonly undo?: () => void };
const ToastContext = createContext<(message: string, options?: { icon?: IconName; undo?: () => void }) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const show = useCallback((message: string, options: { icon?: IconName; undo?: () => void } = {}) => {
    setToast({ id: Date.now(), message, icon: options.icon ?? "check", undo: options.undo });
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-slot">
        {toast ? (
          <ChalkToast
            key={toast.id}
            type={toast.icon === "alert" ? "error" : "success"}
            duration={toast.icon === "alert" ? Infinity : toast.undo ? 6000 : 3200}
            message={toast.message}
            action={
              toast.undo
                ? {
                    label: "Undo",
                    onClick: () => {
                      toast.undo?.();
                      setToast(null);
                    },
                  }
                : undefined
            }
            onDismiss={() => setToast((current) => (current?.id === toast.id ? null : current))}
          />
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- loading and failure ---------- */

export function Sk({ width, height, radius }: { readonly width: string; readonly height: number; readonly radius?: string }) {
  return <span className="sk" style={{ width, height, borderRadius: radius }} />;
}

export function SkeletonRows({ count }: { readonly count: number }) {
  return (
    <div className="list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <div className="skrow" key={index}>
          <Sk width="60px" height={28} radius="999px" />
          <div style={{ flex: 1 }}>
            <Sk width="30%" height={14} />
            <div style={{ height: 8 }} />
            <Sk width="20%" height={11} />
          </div>
          <Sk width="96px" height={12} />
        </div>
      ))}
    </div>
  );
}

export function ErrorPanel({ title, detail, onRetry }: { readonly title: string; readonly detail: string; readonly onRetry?: () => void }) {
  return (
    <div className="errp" role="alert">
      <Icon name="alert" />
      <div>
        <b>{title}</b>
        <span>{detail}</span>
      </div>
      {onRetry ? (
        <button type="button" className="btn sec sm" onClick={onRetry}>
          <Icon name="retry" />
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A copy control that says what happened: the round icon button, or a labeled pill. */
export function CopyAction({ text, label = "Copy link", pill, small, toastMessage = "Link copied" }: { readonly text: string | (() => Promise<string>); readonly label?: string; readonly pill?: boolean; readonly small?: boolean; readonly toastMessage?: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof text === "string" ? text : await text());
      setCopied(true);
      toast(toastMessage);
    } catch {
      toast("Couldn’t copy. Select the text to copy it.", { icon: "alert" });
    }
  }
  if (pill)
    return (
      <button type="button" className={small ? "btn sec sm" : "btn sec"} onClick={() => void copy()}>
        <Icon name={copied ? "check" : "copy"} />
        {copied ? "Copied" : label}
      </button>
    );
  return (
    <button type="button" className={copied ? "ib ok" : "ib"} aria-label={copied ? "Copied" : label} data-tip onClick={() => void copy()}>
      <Icon name={copied ? "check" : "copy"} />
    </button>
  );
}

export function Seg<T extends string>({ label, labelledBy, options, value, onChange, small }: { readonly label?: string; readonly labelledBy?: string; readonly options: readonly (readonly [T, string])[]; readonly value: T; readonly onChange: (value: T) => void; readonly small?: boolean }) {
  return (
    <div className={small ? "seg2 sm" : "seg2"} role="group" aria-label={label} aria-labelledby={labelledBy}>
      {options.map(([option, text]) => (
        <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}
