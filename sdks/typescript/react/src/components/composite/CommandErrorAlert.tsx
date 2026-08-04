import type React from "react";

export interface CommandErrorAlertProps {
  readonly message?: string;
}

export function CommandErrorAlert({ message }: CommandErrorAlertProps): React.JSX.Element | null {
  if (!message) return null;

  return (
    <p role="alert" className="absolute bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full border border-[var(--chalk-danger)] bg-[var(--chalk-danger-surface)] px-4 py-2 text-sm text-[var(--chalk-danger)] backdrop-blur">
      {message}
    </p>
  );
}
