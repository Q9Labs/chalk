import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { errorMessage } from "../../lib/dashboard/client";
import { linkParts } from "../../lib/dashboard/format";
import { trapDialogFocus } from "../docs/dialog-focus";
import { ChalkToast } from "@q9labsai/chalk-react/toast";
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

/** Closes an open popover when a press lands outside its wrapper. */
export function useCloseOnOutsidePress(open: boolean, wrap: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, wrap, setOpen]);
}

export function Menu({ label, trigger, icon = "more", align, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Focus goes back to the trigger first, so a dialog opened from the menu returns focus there too.
  const close = useCallback(() => {
    wrap.current?.querySelector<HTMLElement>("[aria-haspopup=menu]")?.focus();
    setOpen(false);
  }, []);
  useCloseOnOutsidePress(open, wrap, setOpen);
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

/* ---------- dialogs: a card on a scrim, a bottom sheet on the phone ---------- */

type DialogProps = {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly alert?: boolean;
  readonly wide?: boolean;
  /** On a phone the sheet fills the screen height. */
  readonly tall?: boolean;
  /** Artwork above the title, such as the app and Chalk logos. */
  readonly lead?: ReactNode;
  /** A tile beside the title, the heading shape the Developer dialogs use. Body and actions get their own bands. */
  readonly icon?: IconName;
  readonly tone?: "ok";
  /** Quiet text on the left of the actions. */
  readonly hint?: ReactNode;
  readonly onClose: () => void;
  readonly onSubmit?: () => void;
  readonly children?: ReactNode;
  readonly actions: ReactNode;
};

/** Traps focus, closes on Esc or the scrim, and gives focus back to whatever opened it. */
export function Dialog({ title, description, alert, wide, tall, lead, icon, tone, hint, onClose, onSubmit, children, actions }: DialogProps) {
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

  const heading = (
    <>
      <h2 id={titleId}>{title}</h2>
      {description ? <p id={descriptionId}>{description}</p> : null}
    </>
  );
  const inner = (
    <>
      <button type="button" className="ib x" aria-label="Close" onClick={onClose}>
        <Icon name="x" />
      </button>
      {lead}
      {icon ? (
        <div className="dh">
          <span className={tone === "ok" ? "tile ok" : "tile"}>
            <Icon name={icon} size={20} />
          </span>
          <div>{heading}</div>
        </div>
      ) : (
        heading
      )}
      {icon && children ? <div className="db">{children}</div> : children}
      <div className="acts">
        {hint ? <span className="hint">{hint}</span> : null}
        {actions}
      </div>
    </>
  );
  const shared = {
    className: ["dlg", icon && "titled", wide && "w", tall && "tall"].filter(Boolean).join(" "),
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

/** A toast's one button: Undo after a change that can be put back, Try again after a failed action. */
type ToastAction = { readonly label: string; readonly onClick: () => void };
type ToastOptions = { readonly icon?: IconName; readonly action?: ToastAction };
type Toast = { readonly id: number; readonly message: string; readonly icon: IconName; readonly action?: ToastAction };
const ToastContext = createContext<(message: string, options?: ToastOptions) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const show = useCallback((message: string, options: ToastOptions = {}) => {
    setToast({ id: Date.now(), message, icon: options.icon ?? "check", action: options.action });
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-slot">
        {toast ? (
          <ChalkToast
            key={toast.id}
            type={toast.icon === "alert" ? "error" : "success"}
            duration={toast.icon === "alert" ? Infinity : toast.action ? 6000 : 3200}
            message={toast.message}
            action={
              toast.action
                ? {
                    label: toast.action.label,
                    onClick: () => {
                      toast.action?.onClick();
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

/** Placeholder rows in the shape of a Home or Past sessions row: faces, a title over a short line, and the time at the end. */
export function SkeletonRows({ count }: { readonly count: number }) {
  return (
    <div className="list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <div className="skrow" key={index}>
          <span className="fcol">
            <Sk width="28px" height={28} radius="999px" />
          </span>
          <span className="skrow-text">
            <Sk width={`${[38, 28, 44, 32][index % 4]}%`} height={14} />
          </span>
          <Sk width="88px" height={12} />
        </div>
      ))}
    </div>
  );
}

export function ErrorPanel({ title, detail, onRetry, more }: { readonly title: string; readonly detail: string; readonly onRetry?: () => void; readonly more?: ReactNode }) {
  return (
    <div className="errp" role="alert">
      <Icon name="alert" />
      <div>
        <b>{title}</b>
        <span>{detail}</span>
      </div>
      {onRetry || more ? (
        <span className="errp-acts">
          {onRetry ? (
            <button type="button" className="btn sec sm" onClick={onRetry}>
              <Icon name="retry" />
              Try again
            </button>
          ) : null}
          {more}
        </span>
      ) : null}
    </div>
  );
}

/** Puts text on the clipboard. Success is the control's own copy-to-check morph, so only a failure raises a toast. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = useCallback(
    async (text: string | (() => Promise<string>)) => {
      try {
        await navigator.clipboard.writeText(typeof text === "string" ? text : await text());
        setCopied(true);
      } catch {
        toast("Couldn’t copy. Select the text to copy it.", { icon: "alert" });
      }
    },
    [toast],
  );
  return { copied, copy };
}

/** The one copy control: a round icon button whose copy icon morphs to a check, with a tooltip naming what it copies. */
export function CopyAction({ text, label = "Copy link" }: { readonly text: string | (() => Promise<string>); readonly label?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button type="button" className={copied ? "ib copy ok" : "ib copy"} aria-label={copied ? "Copied" : label} data-tip onClick={() => void copy(text)}>
      <span className="copy-glyph" aria-hidden="true">
        <Icon name="copy" />
        <Icon name="check" />
      </span>
      <span className="sr" role="status">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

/** A link as people read it, in a field with its copy control at the end. */
/**
 * A call link as people read it. When space runs out the host gives way first, so the part that names the call stays.
 */
export function LinkText({ link, className = "lf-text" }: { readonly link: string; readonly className?: string }) {
  const { host, path } = linkParts(link);
  return (
    <span className={`${className} ltext`} title={link}>
      <span className="lt-host">{host}</span>
      {path ? <span className="lt-path">{path}</span> : null}
    </span>
  );
}

export function LinkField({ link, label = "Copy link", shown }: { readonly link: string; readonly label?: string; readonly shown?: string }) {
  return (
    <div className="linkfield">
      {shown === undefined ? (
        <LinkText link={link} />
      ) : (
        <span className="lf-text" title={link}>
          {shown}
        </span>
      )}
      <CopyAction text={link} label={label} />
    </div>
  );
}

/**
 * A segmented control. Segments size to their labels, and the thumb takes the measured box of the chosen one, so it
 * always holds its own label. It slides only after the first measure, so the page never opens with a slide.
 */
export function Seg<T extends string>({ label, labelledBy, options, value, onChange, small }: { readonly label?: string; readonly labelledBy?: string; readonly options: readonly (readonly [T, string])[]; readonly value: T; readonly onChange: (value: T) => void; readonly small?: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ readonly x: number; readonly width: number; readonly moved: boolean } | null>(null);
  const at = Math.max(
    0,
    options.findIndex(([option]) => option === value),
  );
  // Inline option arrays are new on every render, so the effect keys on their words, not the array.
  const words = options.map(([, text]) => text).join("\u0000");
  const shownAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const box = group.current;
    if (!box) return;
    // Only a new choice slides the thumb. A first paint, a font swap or a resize puts it in place without motion.
    const moved = shownAt.current !== null && shownAt.current !== at;
    shownAt.current = at;
    const measure = () => {
      const chosen = box.querySelectorAll<HTMLElement>("button")[at];
      if (!chosen) return;
      const x = chosen.offsetLeft;
      const width = chosen.offsetWidth;
      setThumb((current) => (current && current.x === x && current.width === width && current.moved === moved ? current : { x, width, moved }));
    };
    measure();
    // Labels change width when the font arrives or the text wraps the page.
    const resize = new ResizeObserver(measure);
    resize.observe(box);
    return () => resize.disconnect();
  }, [at, words]);
  const style: CSSProperties | undefined = thumb ? { width: thumb.width, transform: `translateX(${thumb.x}px)` } : { visibility: "hidden" };
  return (
    <div ref={group} className={small ? "seg2 sm" : "seg2"} role="group" aria-label={label} aria-labelledby={labelledBy}>
      <span className={thumb?.moved ? "seg-thumb moves" : "seg-thumb"} aria-hidden="true" style={style} />
      {options.map(([option, text]) => (
        <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}
