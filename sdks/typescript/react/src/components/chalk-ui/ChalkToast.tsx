import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChalkButton } from "./ChalkButton";
import { noticeIdentity } from "../toast-stack/notice-announcement";
export interface ChalkToastProps {
  readonly message: ReactNode;
  /** Stable semantic identity for rich message content. Change it when the message changes. */
  readonly announcementKey?: string;
  /** Plain speech text for custom message components. Literal text and markup are read without mounting them. */
  readonly announcementText?: string;
  readonly icon?: ReactNode;
  readonly type?: "info" | "success" | "warning" | "error";
  readonly duration?: number;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** Enables live announcements. Pass false for an already-announced notice; a replacement message can enable the same mounted toast later. */
  readonly announce?: boolean;
  readonly onDismiss: () => void;
}
export function ChalkToast({ message, announcementKey, announcementText, type = "info", duration = type === "info" ? 5000 : Infinity, action, icon, announce = true, onDismiss }: ChalkToastProps) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const identity = noticeIdentity({ message, announcementText, announcementKey, type });
  const [lifetime, setLifetime] = useState({ identity, exiting: false });
  if (lifetime.identity !== identity) setLifetime({ identity, exiting: false });
  const exiting = lifetime.identity === identity && lifetime.exiting;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [timer] Start the toast lifetime for this identity; cancel it when duration or identity changes.
  useEffect(() => {
    if (duration === Infinity) return;
    const timer = setTimeout(() => setLifetime({ identity, exiting: true }), duration);
    return () => clearTimeout(timer);
  }, [duration, identity]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [timer] Dismiss after the exit transition; cancel the timeout if the toast is reused or unmounted.
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => dismissRef.current(), 160);
    return () => clearTimeout(timer);
  }, [exiting, identity]);
  return (
    <div data-part="toast" data-type={type} data-exiting={exiting || undefined} className="chalk-toast" role={announce ? (type === "error" ? "alert" : "status") : undefined} aria-live={announce ? (type === "error" ? "assertive" : "polite") : undefined} aria-atomic={announce || undefined}>
      {icon}
      <span>{message}</span>
      {action ? <ChalkButton onClick={action.onClick}>{action.label}</ChalkButton> : null}
      {type === "error" ? (
        <button type="button" data-part="toast-dismiss" className="chalk-dismiss" aria-label="Dismiss" onClick={() => setLifetime({ identity, exiting: true })}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
