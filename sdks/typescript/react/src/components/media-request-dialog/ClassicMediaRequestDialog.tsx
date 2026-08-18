import type React from "react";
import { useSkin } from "../skin-context";
import type { MediaRequestDialogProps } from "./MediaRequestDialog";

export function ClassicMediaRequestDialog({ request, onDecline, onAllow }: MediaRequestDialogProps): React.JSX.Element {
  const skin = useSkin();
  return (
    <div
      data-chalk-skin={skin}
      role="dialog"
      aria-modal="true"
      aria-label={request.kind === "unmute" ? "Unmute request" : "Camera request"}
      className="chalk-textured-surface absolute bottom-24 left-1/2 z-50 w-[min(92vw,380px)] -translate-x-1/2 rounded-2xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] p-5 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)]"
    >
      <p className="font-semibold text-[var(--chalk-app-text)]">
        {request.actorDisplayName ?? "A participant"} is asking you to {request.kind === "unmute" ? "unmute" : "start your camera"}.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="rounded-lg px-3 py-2 text-sm text-[var(--chalk-app-text-muted)] hover:bg-[var(--chalk-app-control-hover)]" onClick={onDecline}>
          Not now
        </button>
        <button type="button" className="rounded-lg bg-[var(--chalk-app-control-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--chalk-app-control-primary-hover)]" onClick={onAllow}>
          Allow
        </button>
      </div>
    </div>
  );
}
