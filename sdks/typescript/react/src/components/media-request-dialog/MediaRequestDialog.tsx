import type { IncomingMediaRequest } from "@q9labsai/chalk-client";
import type React from "react";

import { ChalkButton, ChalkDialogPanel } from "../chalk-ui";

export interface MediaRequestDialogProps {
  readonly request: IncomingMediaRequest;
  readonly onDecline: () => void;
  readonly onAllow: () => void;
}

export function MediaRequestDialog({ request, onDecline, onAllow }: MediaRequestDialogProps): React.JSX.Element {
  return (
    <ChalkDialogPanel role="dialog" aria-modal="true" aria-label={request.kind === "unmute" ? "Unmute request" : "Camera request"} className="absolute bottom-24 left-1/2 z-50 w-[min(92vw,380px)] -translate-x-1/2 p-5 text-[var(--chalk-app-text)]" tone="neutral">
      <p className="font-semibold text-[var(--chalk-app-text)]">
        {request.actorDisplayName ?? "A participant"} is asking you to {request.kind === "unmute" ? "unmute" : "start your camera"}.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <ChalkButton type="button" variant="ghost" tone="neutral" className="px-3 py-2 text-sm text-[var(--chalk-app-text-muted)]" onClick={onDecline}>
          Not now
        </ChalkButton>
        <ChalkButton type="button" variant="solid" tone="accent" className="px-3 py-2 text-sm font-medium text-[var(--chalk-app-control-active-text)]" onClick={onAllow}>
          Allow
        </ChalkButton>
      </div>
    </ChalkDialogPanel>
  );
}
