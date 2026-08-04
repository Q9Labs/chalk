import type { IncomingMediaRequest } from "@q9labsai/chalk-client";
import type React from "react";

export interface MediaRequestDialogProps {
  readonly request: IncomingMediaRequest;
  readonly onDecline: () => void;
  readonly onAllow: () => void;
}

export function MediaRequestDialog({ request, onDecline, onAllow }: MediaRequestDialogProps): React.JSX.Element {
  return (
    <div role="dialog" aria-modal="true" aria-label={request.kind === "unmute" ? "Unmute request" : "Camera request"} className="absolute bottom-24 left-1/2 z-50 w-[min(92vw,380px)] -translate-x-1/2 rounded-2xl border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-5 shadow-2xl">
      <p className="font-semibold">
        {request.actorDisplayName ?? "A space moderator"} is asking you to {request.kind === "unmute" ? "unmute" : "start your camera"}.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="rounded-lg px-3 py-2 text-sm text-[var(--chalk-muted-text)] hover:bg-[var(--chalk-stage)]" onClick={onDecline}>
          Not now
        </button>
        <button type="button" className="rounded-lg bg-[var(--chalk-accent)] px-3 py-2 text-sm font-medium text-[var(--chalk-accent-text)]" onClick={onAllow}>
          Allow
        </button>
      </div>
    </div>
  );
}
