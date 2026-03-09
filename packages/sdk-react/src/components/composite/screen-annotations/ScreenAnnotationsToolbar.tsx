import type { AnnotationAccessMode, ScreenAnnotationTool } from "@q9labs/chalk-core";
import { memo } from "react";
import { Edit02Icon } from "../../../utils/icons";
import { cn } from "../../../utils/cn";

const DRAW_TOOLS: Array<{ tool: ScreenAnnotationTool; label: string }> = [
  { tool: "pen", label: "Pen" },
  { tool: "highlighter", label: "Highlight" },
  { tool: "rectangle", label: "Rect" },
  { tool: "ellipse", label: "Ellipse" },
  { tool: "line", label: "Line" },
  { tool: "arrow", label: "Arrow" },
  { tool: "text", label: "Text" },
];

const ACCESS_MODES: Array<{ value: AnnotationAccessMode; label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "sharer_only", label: "Sharer" },
  { value: "off", label: "Off" },
];

interface ScreenAnnotationsToolbarProps {
  isOpen: boolean;
  canDraw: boolean;
  canLaunch: boolean;
  isHost: boolean;
  isSessionActive: boolean;
  activeTool: ScreenAnnotationTool;
  accessMode: AnnotationAccessMode;
  canUndo: boolean;
  canRedo: boolean;
  onOpen: () => void;
  onClose: () => void;
  onToolChange: (tool: ScreenAnnotationTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onAccessModeChange: (accessMode: AnnotationAccessMode) => void;
}

const baseButtonClass = "rounded-full border border-white/10 bg-zinc-950/82 px-3 py-2 text-xs font-semibold text-white/82 backdrop-blur-md transition hover:bg-zinc-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-45";

export const ScreenAnnotationsToolbar = memo(({ isOpen, canDraw, canLaunch, isHost, isSessionActive, activeTool, accessMode, canUndo, canRedo, onOpen, onClose, onToolChange, onUndo, onRedo, onClear, onAccessModeChange }: ScreenAnnotationsToolbarProps) => {
  if (!isOpen) {
    if (!canLaunch) {
      return null;
    }

    return (
      <div className="absolute bottom-5 left-5 z-30">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-cyan-300/28 bg-zinc-950/88 px-4 py-3 text-sm font-semibold text-cyan-50 shadow-2xl shadow-black/35 backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-zinc-900 hover:text-white"
          onClick={onOpen}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500/18 text-cyan-200">
            <Edit02Icon size={18} />
          </span>
          <span>Annotate</span>
        </button>
      </div>
    );
  }

  return (
    <div className="absolute left-1/2 top-4 z-30 flex w-[min(92%,920px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-[28px] border border-white/10 bg-zinc-950/74 px-3 py-3 shadow-2xl shadow-black/30 backdrop-blur-xl">
      {DRAW_TOOLS.map(({ tool, label }) => (
        <button key={tool} type="button" disabled={!canDraw} className={cn(baseButtonClass, activeTool === tool && "border-cyan-400/50 bg-cyan-500/18 text-cyan-50")} onClick={() => onToolChange(tool)}>
          {label}
        </button>
      ))}
      <div className="mx-1 h-6 w-px bg-white/12" />
      <button type="button" className={baseButtonClass} disabled={!canDraw || !canUndo} onClick={onUndo}>
        Undo
      </button>
      <button type="button" className={baseButtonClass} disabled={!canDraw || !canRedo} onClick={onRedo}>
        Redo
      </button>
      <button type="button" className={baseButtonClass} disabled={!canDraw} onClick={onClear}>
        Clear
      </button>
      {isHost ? (
        <>
          <div className="mx-1 h-6 w-px bg-white/12" />
          {ACCESS_MODES.map(({ value, label }) => (
            <button key={value} type="button" disabled={!isSessionActive} className={cn(baseButtonClass, accessMode === value && "border-amber-400/50 bg-amber-500/18 text-amber-50")} onClick={() => onAccessModeChange(value)}>
              {label}
            </button>
          ))}
        </>
      ) : null}
      {!isSessionActive ? (
        <>
          <div className="mx-1 h-6 w-px bg-white/12" />
          <div className="px-2 text-xs font-medium text-white/60">Connecting annotations...</div>
        </>
      ) : null}
      <div className="mx-1 h-6 w-px bg-white/12" />
      <button type="button" className={baseButtonClass} onClick={onClose}>
        Close
      </button>
    </div>
  );
});

ScreenAnnotationsToolbar.displayName = "ScreenAnnotationsToolbar";
