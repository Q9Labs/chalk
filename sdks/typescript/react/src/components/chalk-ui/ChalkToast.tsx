import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChalkButton } from "./ChalkButton";
export interface ChalkToastProps {
  readonly message: ReactNode;
  readonly icon?: ReactNode;
  readonly type?: "info" | "success" | "warning" | "error";
  readonly duration?: number;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  readonly onDismiss: () => void;
}
export function ChalkToast({ message, type = "info", duration = type === "info" ? 5000 : Infinity, action, icon, onDismiss }: ChalkToastProps) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (duration === Infinity) return;
    const timer = setTimeout(() => setExiting(true), duration);
    return () => clearTimeout(timer);
  }, [duration]);
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => dismissRef.current(), 160);
    return () => clearTimeout(timer);
  }, [exiting]);
  return (
    <div data-part="toast" data-type={type} data-exiting={exiting || undefined} className="chalk-toast" role={type === "error" ? "alert" : "status"} aria-live={type === "error" ? "assertive" : "polite"} aria-atomic="true">
      <ToastFace message={message} type={type} action={action} icon={icon} onDismiss={() => setExiting(true)} />
    </div>
  );
}

/** What a notice shows. A toast stack also renders it inert to measure a notice before it mounts the toast. */
export function ToastFace({ message, type, action, icon, onDismiss }: Pick<ChalkToastProps, "message" | "type" | "action" | "icon" | "onDismiss">) {
  return (
    <>
      {icon}
      <span>{message}</span>
      {action ? <ChalkButton onClick={action.onClick}>{action.label}</ChalkButton> : null}
      {type === "error" ? (
        <button type="button" data-part="toast-dismiss" className="chalk-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      ) : null}
    </>
  );
}
