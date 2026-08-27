import { useEffect, type FormEventHandler, type ReactNode, type RefObject } from "react";
import { DashboardAPIError } from "../../lib/dashboard-api";

export function useModalDialog(dialogRef: RefObject<HTMLDialogElement | null>, open: boolean, onOpen?: () => void) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      onOpen?.();
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [dialogRef, onOpen, open]);
}

function SpaceDialogChrome({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="space-dialog-accent" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <button className="dialog-close" type="button" onClick={onClose} aria-label="Close dialog">
        ×
      </button>
    </>
  );
}

export function SpaceDialogHeading({ title, description }: { title: string; description: string }) {
  return (
    <>
      <h2>{title}</h2>
      <p className="dialog-intro">{description}</p>
    </>
  );
}

export function SpaceDialogFrame({
  dialogRef,
  onClose,
  onSubmit,
  children,
  ariaLabel,
  dataFeedbackPrivate = false,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
  ariaLabel?: string;
  dataFeedbackPrivate?: boolean;
}) {
  return (
    <dialog ref={dialogRef} aria-label={ariaLabel} className="space-dialog" data-chalk-feedback-private={dataFeedbackPrivate ? "true" : undefined} onClose={onClose} onCancel={onClose}>
      <form onSubmit={onSubmit}>
        <SpaceDialogChrome onClose={onClose} />
        {children}
      </form>
    </dialog>
  );
}

export function SpaceDialogActions({ onClose, disabled, busyLabel, submitLabel }: { onClose: () => void; disabled: boolean; busyLabel?: string; submitLabel: string }) {
  return (
    <div className="dialog-actions">
      <button type="button" className="dashboard-button secondary" onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className="dashboard-button primary" disabled={disabled}>
        {busyLabel ?? submitLabel}
      </button>
    </div>
  );
}

export function SpaceDialogError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="fixture-note">
      {message}
    </p>
  ) : null;
}

export function slugifySpaceName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function runSpaceMutation<Result>({ request, onSuccess, setBusy, setError, failureMessage }: { request: () => Promise<Result>; onSuccess: (result: Result) => void; setBusy: (busy: boolean) => void; setError: (message: string | null) => void; failureMessage: string }) {
  setBusy(true);
  setError(null);
  try {
    onSuccess(await request());
  } catch (cause: unknown) {
    setError(cause instanceof DashboardAPIError ? cause.message : failureMessage);
  } finally {
    setBusy(false);
  }
}
