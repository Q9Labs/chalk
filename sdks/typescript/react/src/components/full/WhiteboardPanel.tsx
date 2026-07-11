import { memo } from "react";
import { WhiteboardCanvas, type WhiteboardCanvasProps, type WhiteboardCollaborationOptions } from "@q9labsai/chalk-whiteboard/react";

import { Cancel01Icon, CheckmarkCircle02Icon, Loading01Icon } from "../../utils/icons";

export type WhiteboardCollabOptions = WhiteboardCollaborationOptions;
export type WhiteboardPanelProps = Omit<WhiteboardCanvasProps, "classNames" | "icons">;

const classNames = {
  root: "relative flex min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-background",
  toolbar: "absolute left-3 top-3 z-20 flex items-center gap-2 rounded-lg border border-border bg-popover/95 p-1 shadow-sm",
  toolbarButton: "flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-semibold text-popover-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
  loading: "absolute inset-0 z-30 flex items-center justify-center bg-background text-foreground",
  loadingContent: "flex items-center gap-3 text-sm text-muted-foreground",
  error: "absolute inset-0 z-30 flex items-center justify-center bg-background p-6 text-center text-destructive",
  mathOverlay: "absolute inset-0 z-40 flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm",
  mathDialog: "w-full max-w-xl rounded-lg border border-border bg-popover shadow-xl",
  mathHeader: "flex items-center justify-between border-b border-border px-4 py-3",
  mathTitle: "text-sm font-medium text-popover-foreground",
  mathCloseButton: "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
  mathBody: "space-y-3 p-4",
  mathTextarea: "min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
  mathError: "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
  mathActions: "flex justify-end gap-2",
  mathCancelButton: "h-9 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
  mathSubmitButton: "inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
} as const;

const icons = {
  close: <Cancel01Icon className="h-4 w-4" />,
  loading: <Loading01Icon className="h-5 w-5 animate-spin" />,
  submit: <CheckmarkCircle02Icon className="h-4 w-4" />,
  submitting: <Loading01Icon className="h-4 w-4 animate-spin" />,
} as const;

function WhiteboardPanelBase(props: WhiteboardPanelProps): React.JSX.Element {
  return <WhiteboardCanvas {...props} classNames={classNames} icons={icons} />;
}

export const WhiteboardPanel = memo(WhiteboardPanelBase);
WhiteboardPanel.displayName = "WhiteboardPanel";
