import { memo } from "react";
import { WhiteboardCanvas, type WhiteboardCanvasProps, type WhiteboardCollaborationOptions } from "@q9labsai/chalk-whiteboard/react";

import { Cancel01Icon, CheckmarkCircle02Icon, Loading01Icon } from "../../utils/icons";

export type WhiteboardCollabOptions = WhiteboardCollaborationOptions;
export type WhiteboardViewProps = Omit<WhiteboardCanvasProps, "classNames" | "icons">;

const classNames = {
  root: "relative flex min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)]",
  toolbar: "absolute left-3 top-3 z-20 flex items-center gap-2 rounded-[9px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-1 shadow-[var(--chalk-shadow)]",
  toolbarButton: "flex h-8 min-w-8 items-center justify-center rounded-[6px] px-2 text-sm font-semibold text-[var(--chalk-text)] hover:bg-[var(--chalk-stage)] disabled:cursor-not-allowed disabled:opacity-50",
  loading: "absolute inset-0 z-30 flex items-center justify-center bg-[var(--chalk-surface)] text-[var(--chalk-text)]",
  loadingContent: "flex items-center gap-3 text-sm text-[var(--chalk-muted-text)]",
  error: "absolute inset-0 z-30 flex items-center justify-center bg-[var(--chalk-surface)] p-6 text-center text-[var(--chalk-danger)]",
  mathOverlay: "absolute inset-0 z-40 flex items-center justify-center bg-[var(--chalk-text)] px-4 backdrop-blur-[1px]",
  mathDialog: "w-full max-w-xl rounded-[12px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] shadow-[var(--chalk-shadow)]",
  mathHeader: "flex items-center justify-between border-b border-[var(--chalk-line)] px-4 py-3",
  mathTitle: "text-sm font-semibold text-[var(--chalk-text)]",
  mathCloseButton: "flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--chalk-muted-text)] hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]",
  mathBody: "space-y-3 p-4",
  mathTextarea: "min-h-28 w-full resize-y rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] px-3 py-2 font-mono text-sm text-[var(--chalk-text)] outline-none focus-visible:border-[var(--chalk-focus)]",
  mathError: "rounded-md border border-[var(--chalk-danger)] bg-[var(--chalk-danger-surface)] px-3 py-2 text-sm text-[var(--chalk-danger)]",
  mathActions: "flex justify-end gap-2",
  mathCancelButton: "h-9 rounded-[7px] border border-[var(--chalk-line)] px-3 text-sm text-[var(--chalk-muted-text)] hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]",
  mathSubmitButton: "inline-flex h-9 items-center gap-2 rounded-[7px] bg-[var(--chalk-text)] px-3 text-sm font-medium !text-[var(--chalk-accent-text)] hover:bg-[var(--chalk-text)] disabled:cursor-not-allowed disabled:opacity-50",
} as const;

const icons = {
  close: <Cancel01Icon className="h-4 w-4" />,
  loading: <Loading01Icon className="h-5 w-5 animate-spin" />,
  submit: <CheckmarkCircle02Icon className="h-4 w-4" />,
  submitting: <Loading01Icon className="h-4 w-4 animate-spin" />,
} as const;

function WhiteboardViewBase(props: WhiteboardViewProps): React.JSX.Element {
  return <WhiteboardCanvas {...props} classNames={classNames} icons={icons} />;
}

export const WhiteboardView = memo(WhiteboardViewBase);
WhiteboardView.displayName = "WhiteboardView";
