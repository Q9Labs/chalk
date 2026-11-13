import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { errorMessage } from "../../lib/dashboard/client";
import { linkParts } from "../../lib/dashboard/format";
import { useMediaQuery } from "../../lib/use-media-query";
import { ChalkToast } from "@q9labsai/chalk-react/toast";
import { CopyButton } from "../site/CopyButton";
import { Icon, type IconName } from "../site/Icon";

const PHONE = "(max-width: 640px)";

/** True on a phone-width screen, where rows and dialogs change shape, not only size. */
export function usePhone(): boolean {
  return useMediaQuery(PHONE);
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
const COPY_FAILED = "Couldn’t copy. Select the text to copy it.";

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
        toast(COPY_FAILED, { icon: "alert" });
      }
    },
    [toast],
  );
  return { copied, copy };
}

/** The dashboard's copy control: the site's copy button, whose tooltip names what it copies, and a toast when a copy fails. */
export function CopyAction({ text, label = "Copy link" }: { readonly text: string | (() => Promise<string>); readonly label?: string }) {
  const toast = useToast();
  return <CopyButton text={text} label={label} onFailed={() => toast(COPY_FAILED, { icon: "alert" })} />;
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
