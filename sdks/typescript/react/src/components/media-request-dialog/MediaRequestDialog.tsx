import type React from "react";
import { Microphone01Icon, Video01Icon } from "../../utils/icons";
import { ChalkButton } from "../chalk-ui/ChalkButton";
import { useMediaRequestDialogState } from "./media-request-dialog-state";
import type { IncomingMediaRequest } from "@q9labsai/chalk-client";
import { type MediaRequestActionErrorHandler, type MediaRequestActionHandler } from "./media-request-dialog-state";

export interface MediaRequestDialogProps {
  readonly request: IncomingMediaRequest;
  readonly onDecline: MediaRequestActionHandler;
  readonly onAllow: MediaRequestActionHandler;
  /** Called with null after success, or a safe message when the action fails. */
  readonly onActionError?: MediaRequestActionErrorHandler;
}

export type { MediaRequestAction } from "./media-request-dialog-state";

export function MediaRequestDialog({ request, onDecline, onAllow, onActionError }: MediaRequestDialogProps): React.JSX.Element {
  const { isExpired, expiryLabel, pendingAction, errorMessage, runAction } = useMediaRequestDialogState({ request, onDecline, onAllow, onActionError });
  const RequestIcon = request.kind === "unmute" ? Microphone01Icon : Video01Icon;

  return (
    <div role="dialog" aria-modal="true" aria-label={request.kind === "unmute" ? "Unmute request" : "Camera request"} aria-busy={pendingAction !== null} data-part="toast" data-type="info" className="chalk-toast">
      <span data-part="toast-icon" aria-hidden="true">
        <RequestIcon />
      </span>
      <span data-part="toast-message">
        <b style={{ fontWeight: 600 }}>
          {request.actorDisplayName ?? "A participant"} is asking you to {request.kind === "unmute" ? "unmute" : "start your camera"}.
        </b>
        {expiryLabel ? (
          <>
            {" "}
            <span role="status" style={{ color: "var(--chalk-muted-text)" }}>
              {expiryLabel}
            </span>
          </>
        ) : null}
        {errorMessage ? (
          <span role="alert" style={{ display: "block", color: "var(--chalk-danger-text)" }}>
            {errorMessage}
          </span>
        ) : null}
      </span>
      <ChalkButton variant="ghost" onClick={() => runAction("decline")} disabled={isExpired || pendingAction !== null}>
        Not now
      </ChalkButton>
      <ChalkButton variant="solid" onClick={() => runAction("allow")} disabled={isExpired || pendingAction !== null}>
        {isExpired ? "Expired" : pendingAction === "allow" ? "Working…" : "Allow"}
      </ChalkButton>
    </div>
  );
}
