import type { IncomingMediaRequest } from "@q9labsai/chalk-client";
import type React from "react";
import { ClassicMediaRequestDialog } from "./ClassicMediaRequestDialog";
import { type MediaRequestActionErrorHandler, type MediaRequestActionHandler } from "./media-request-dialog-state";

export interface MediaRequestDialogProps {
  readonly request: IncomingMediaRequest;
  readonly onDecline: MediaRequestActionHandler;
  readonly onAllow: MediaRequestActionHandler;
  /** Called with null after success, or a safe message when the action fails. */
  readonly onActionError?: MediaRequestActionErrorHandler;
}

export function MediaRequestDialog(props: MediaRequestDialogProps): React.JSX.Element {
  return <ClassicMediaRequestDialog {...props} />;
}

export type { MediaRequestAction } from "./media-request-dialog-state";
