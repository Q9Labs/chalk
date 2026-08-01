import { memo } from "react";
import { WhiteboardCanvas, type WhiteboardCanvasProps, type WhiteboardCollaborationOptions } from "@q9labsai/chalk-whiteboard/react";

import { Cancel01Icon, CheckmarkCircle02Icon, Loading01Icon } from "../../utils/icons";

export type WhiteboardCollabOptions = WhiteboardCollaborationOptions;
export type WhiteboardPanelProps = Omit<WhiteboardCanvasProps, "classNames" | "icons">;

const classNames = {
  root: "relative flex min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-[8px] border border-[#c9c8c2] bg-white",
  toolbar: "absolute left-3 top-3 z-20 flex items-center gap-2 rounded-[9px] border border-[#c9c8c2] bg-[#fbfaf7]/95 p-1 shadow-[0_8px_24px_rgba(12,14,18,0.08)]",
  toolbarButton: "flex h-8 min-w-8 items-center justify-center rounded-[6px] px-2 text-sm font-semibold text-[#202329] hover:bg-[#eeede8] disabled:cursor-not-allowed disabled:opacity-50",
  loading: "absolute inset-0 z-30 flex items-center justify-center bg-[#fbfaf7] text-[#202329]",
  loadingContent: "flex items-center gap-3 text-sm text-[#6d727b]",
  error: "absolute inset-0 z-30 flex items-center justify-center bg-[#fbfaf7] p-6 text-center text-[#9f3f3f]",
  mathOverlay: "absolute inset-0 z-40 flex items-center justify-center bg-[#0c0e12]/20 px-4 backdrop-blur-[1px]",
  mathDialog: "w-full max-w-xl rounded-[12px] border border-[#c9c8c2] bg-[#fbfaf7] shadow-[0_24px_70px_rgba(12,14,18,0.18)]",
  mathHeader: "flex items-center justify-between border-b border-[#deddd7] px-4 py-3",
  mathTitle: "text-sm font-semibold text-[#202329]",
  mathCloseButton: "flex h-8 w-8 items-center justify-center rounded-[6px] text-[#6d727b] hover:bg-[#eeede8] hover:text-[#202329]",
  mathBody: "space-y-3 p-4",
  mathTextarea: "min-h-28 w-full resize-y rounded-[8px] border border-[#c9c8c2] bg-white px-3 py-2 font-mono text-sm text-[#202329] outline-none focus-visible:border-[#74b7cf]",
  mathError: "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
  mathActions: "flex justify-end gap-2",
  mathCancelButton: "h-9 rounded-[7px] border border-[#deddd7] px-3 text-sm text-[#6d727b] hover:bg-[#eeede8] hover:text-[#202329]",
  mathSubmitButton: "inline-flex h-9 items-center gap-2 rounded-[7px] bg-[#202329] px-3 text-sm font-medium !text-white hover:bg-[#343840] disabled:cursor-not-allowed disabled:opacity-50",
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
