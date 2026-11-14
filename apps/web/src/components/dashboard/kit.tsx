import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { errorMessage } from "../../lib/dashboard/client";
import { useMediaQuery } from "../../lib/use-media-query";
import { ChalkToast } from "@q9labsai/chalk-react/toast";
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

/** Puts text on the clipboard and says what happened: `copied` is true for a moment, a toast confirms or explains the failure. */
export function useCopy(toastMessage: string) {
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
        toast(toastMessage);
      } catch {
        toast("Couldn’t copy. Select the text to copy it.", { icon: "alert" });
      }
    },
    [toast, toastMessage],
  );
  return { copied, copy };
}

/** A copy control that says what happened: the round icon button, or a labeled pill. */
export function CopyAction({ text, label = "Copy link", pill, small, toastMessage = "Link copied" }: { readonly text: string | (() => Promise<string>); readonly label?: string; readonly pill?: boolean; readonly small?: boolean; readonly toastMessage?: string }) {
  const { copied, copy } = useCopy(toastMessage);
  if (pill)
    return (
      <button type="button" className={small ? "btn sec sm" : "btn sec"} onClick={() => void copy(text)}>
        <Icon name={copied ? "check" : "copy"} />
        {copied ? "Copied" : label}
      </button>
    );
  return (
    <button type="button" className={copied ? "ib ok" : "ib"} aria-label={copied ? "Copied" : label} data-tip onClick={() => void copy(text)}>
      <Icon name={copied ? "check" : "copy"} />
    </button>
  );
}

export function Seg<T extends string>({ label, labelledBy, options, value, onChange, small }: { readonly label?: string; readonly labelledBy?: string; readonly options: readonly (readonly [T, string])[]; readonly value: T; readonly onChange: (value: T) => void; readonly small?: boolean }) {
  return (
    <div className={small ? "seg2 sm" : "seg2"} role="group" aria-label={label} aria-labelledby={labelledBy}>
      {/* Segments share one width, so the thumb slides by whole segments on transform alone. */}
      <span
        className="seg-thumb"
        aria-hidden="true"
        style={{
          width: `calc((100% - 2 * var(--space-1)) / ${options.length})`,
          transform: `translateX(${
            Math.max(
              0,
              options.findIndex(([option]) => option === value),
            ) * 100
          }%)`,
        }}
      />
      {options.map(([option, text]) => (
        <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}
