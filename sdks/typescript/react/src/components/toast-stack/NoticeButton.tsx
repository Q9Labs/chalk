import { useState } from "react";
import { ChalkButton } from "../chalk-ui/ChalkButton";
import { ChalkPopover } from "../chalk-ui/ChalkPopover";
import type { Toast } from "./ToastStack";
export interface NoticeButtonProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
}
/** The header's way into notices that have no room on the stage, such as on a short screen with the board's tools open. */
export function NoticeButton({ toasts, onDismiss }: NoticeButtonProps) {
  const [open, setOpen] = useState(false);
  if (toasts.length === 0) return null;
  const label = toasts.length === 1 ? "1 notice" : `${toasts.length} notices`;
  const trigger = (
    <button type="button" data-part="notice-button" className="chalk-notice-button" aria-label={`Show ${label}`}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5h.01" />
      </svg>
      {toasts.length > 1 ? <span>{toasts.length}</span> : null}
    </button>
  );
  return (
    <ChalkPopover open={open} onOpenChange={setOpen} tooltip={label} trigger={trigger} label="Notices" className="chalk-notice-list">
      {toasts.map((toast) => (
        <div key={toast.id} data-part="notice" data-type={toast.type ?? "info"} className="chalk-notice">
          {toast.icon}
          <span>{toast.message}</span>
          {toast.action ? <ChalkButton onClick={toast.action.onClick}>{toast.action.label}</ChalkButton> : null}
          <button type="button" className="chalk-dismiss" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </button>
        </div>
      ))}
    </ChalkPopover>
  );
}
