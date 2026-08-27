import type { IncomingMediaRequest } from "@q9labsai/chalk-client";
import type React from "react";

import { ChalkButton, ChalkDialogPanel } from "../chalk-ui";
import { Microphone01Icon, Video01Icon } from "../../utils/icons";
import { useSkin } from "../skin-context";
import { ClassicMediaRequestDialog } from "./ClassicMediaRequestDialog";
import { useMediaRequestDialogState, type MediaRequestActionErrorHandler, type MediaRequestActionHandler } from "./media-request-dialog-state";

export interface MediaRequestDialogProps {
  readonly request: IncomingMediaRequest;
  readonly onDecline: MediaRequestActionHandler;
  readonly onAllow: MediaRequestActionHandler;
  /** Called with null after success, or a safe message when the action fails. */
  readonly onActionError?: MediaRequestActionErrorHandler;
}

function ChalkMediaRequestDialog({ request, onDecline, onAllow, onActionError }: MediaRequestDialogProps): React.JSX.Element {
  const skin = useSkin();
  const { isExpired, expiryLabel, pendingAction, errorMessage, runAction } = useMediaRequestDialogState({ request, onDecline, onAllow, onActionError });
  const RequestIcon = request.kind === "unmute" ? Microphone01Icon : Video01Icon;

  return (
    <ChalkDialogPanel
      data-chalk-skin={skin}
      role="dialog"
      aria-modal="true"
      aria-label={request.kind === "unmute" ? "Unmute request" : "Camera request"}
      className="absolute bottom-24 left-1/2 z-50 w-[min(92vw,400px)] -translate-x-1/2 p-5 text-[var(--chalk-app-text)]"
      tone="neutral"
      aria-busy={pendingAction !== null}
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
        <ChalkButton type="button" variant="ghost" tone="neutral" className="px-3 py-2 text-sm text-[var(--chalk-app-text-muted)]" onClick={() => runAction("decline")} disabled={isExpired || pendingAction !== null}>
          Not now
        </ChalkButton>
        <ChalkButton type="button" variant="solid" tone="accent" className="px-3 py-2 text-sm font-medium text-[var(--chalk-app-control-active-text)]" onClick={() => runAction("allow")} disabled={isExpired || pendingAction !== null} loading={pendingAction === "allow"}>
          {isExpired ? "Expired" : "Allow"}
        </ChalkButton>
      </div>
    </ChalkDialogPanel>
  );
}

export function MediaRequestDialog(props: MediaRequestDialogProps): React.JSX.Element {
  const skin = useSkin();
  return skin === "classic" ? <ClassicMediaRequestDialog {...props} /> : <ChalkMediaRequestDialog {...props} />;
}

export type { MediaRequestAction } from "./media-request-dialog-state";
