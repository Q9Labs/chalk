import type React from "react";
import { Microphone01Icon, Video01Icon } from "../../utils/icons";
import { useSkin } from "../skin-context";
import type { MediaRequestDialogProps } from "./MediaRequestDialog";
import { useMediaRequestDialogState } from "./media-request-dialog-state";

export function ClassicMediaRequestDialog({ request, onDecline, onAllow, onActionError }: MediaRequestDialogProps): React.JSX.Element {
  const skin = useSkin();
  const { isExpired, expiryLabel, pendingAction, errorMessage, runAction } = useMediaRequestDialogState({ request, onDecline, onAllow, onActionError });
  const RequestIcon = request.kind === "unmute" ? Microphone01Icon : Video01Icon;

  return (
    <div
      data-chalk-skin={skin}
      role="dialog"
      aria-modal="true"
      aria-label={request.kind === "unmute" ? "Unmute request" : "Camera request"}
      aria-busy={pendingAction !== null}
      className="chalk-textured-surface absolute bottom-24 left-1/2 z-50 w-[min(92vw,400px)] -translate-x-1/2 rounded-2xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] p-5 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)]"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--chalk-app-control-group)] text-[var(--chalk-app-text)]" aria-hidden="true">
          <RequestIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--chalk-app-text)]">
            {request.actorDisplayName ?? "A participant"} is asking you to {request.kind === "unmute" ? "unmute" : "start your camera"}.
          </p>
          {expiryLabel ? (
            <p className="mt-1 text-xs text-[var(--chalk-app-text-muted)]" role="status">
              {expiryLabel}
            </p>
          ) : null}
        </div>
      </div>
      {errorMessage ? (
        <p className="mt-3 rounded-md border border-[var(--chalk-app-danger)]/35 bg-[var(--chalk-app-danger)]/10 px-3 py-2 text-sm text-[var(--chalk-app-danger)]" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="rounded-lg px-3 py-2 text-sm text-[var(--chalk-app-text-muted)] hover:bg-[var(--chalk-app-control-hover)] disabled:cursor-not-allowed disabled:opacity-55" onClick={() => runAction("decline")} disabled={isExpired || pendingAction !== null}>
          Not now
        </button>
        <button
          type="button"
          className="rounded-lg bg-[var(--chalk-app-control-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--chalk-app-control-primary-hover)] disabled:cursor-not-allowed disabled:opacity-55"
          onClick={() => runAction("allow")}
          disabled={isExpired || pendingAction !== null}
        >
          {isExpired ? "Expired" : pendingAction === "allow" ? "Working…" : "Allow"}
        </button>
      </div>
    </div>
  );
}
