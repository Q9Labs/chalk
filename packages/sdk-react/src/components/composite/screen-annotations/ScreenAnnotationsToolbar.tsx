import type { AnnotationAccessMode, ScreenAnnotationTool } from "@q9labs/chalk-core";
import { memo } from "react";
import { Edit02Icon, CircleIcon, SquareIcon, TextIcon, ArrowLeft02Icon, ArrowRight01Icon, Cancel01Icon } from "../../../utils/icons";
import { cn } from "../../../utils/cn";
import { Button } from "../../ui/button";
import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";

const DRAW_TOOLS: Array<{ tool: ScreenAnnotationTool; label: string; icon: React.ReactNode }> = [
  { tool: "pen", label: "Pen", icon: <Edit02Icon className="size-4" /> },
  { tool: "highlighter", label: "Highlight", icon: <Edit02Icon className="size-4 opacity-50" /> },
  { tool: "rectangle", label: "Rectangle", icon: <SquareIcon className="size-4" /> },
  { tool: "ellipse", label: "Ellipse", icon: <CircleIcon className="size-4" /> },
  {
    tool: "line",
    label: "Line",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="size-4">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    ),
  },
  {
    tool: "arrow",
    label: "Arrow",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="size-4">
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
    ),
  },
  { tool: "text", label: "Text", icon: <TextIcon className="size-4" /> },
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

export const ScreenAnnotationsToolbar = memo((props: ScreenAnnotationsToolbarProps) => {
  if (!props.isOpen) {
    if (!props.canLaunch) {
      return null;
    }

    return (
      <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
        <Button size="lg" variant="outline" className="h-12 gap-2.5 rounded-full border-border/50 bg-background/85 px-6 font-semibold shadow-xl backdrop-blur-xl transition hover:-translate-y-1 hover:bg-muted dark:bg-zinc-950/85" onClick={props.onOpen}>
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Edit02Icon className="size-3.5" />
          </span>
          <span>Annotate Screen</span>
        </Button>
      </div>
    );
  }

  return (
    <TooltipProvider delay={200}>
      <div className="fixed bottom-6 left-1/2 z-50 flex w-[max-content] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-border/50 bg-background/85 p-2 shadow-2xl backdrop-blur-xl animate-in slide-in-from-bottom-5 dark:bg-zinc-950/85">
        {/* Tools Section */}
        <div className="flex items-center gap-1 pr-1">
          {DRAW_TOOLS.map(({ tool, label, icon }) => (
            <Tooltip key={tool}>
              <TooltipTrigger
                render={
                  <Toggle size="sm" pressed={props.activeTool === tool} disabled={!props.canDraw} onPressedChange={() => props.onToolChange(tool)} className="data-[state=on]:bg-primary/15 data-[state=on]:text-primary">
                    {icon}
                  </Toggle>
                }
              />
              <TooltipContent side="top" sideOffset={12} className="font-medium">
                {label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="mx-1 h-6 w-px bg-border/50" />

        {/* History Section */}
        <div className="flex items-center gap-1 px-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" disabled={!props.canDraw || !props.canUndo} onClick={props.onUndo}>
                  <ArrowLeft02Icon className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={12} className="font-medium">
              Undo
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" disabled={!props.canDraw || !props.canRedo} onClick={props.onRedo}>
                  <ArrowRight01Icon className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="top" sideOffset={12} className="font-medium">
              Redo
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="mx-1 h-6 w-px bg-border/50" />

        {/* Actions Section */}
        <div className="flex items-center gap-1 px-1">
          <Button variant="ghost" size="sm" disabled={!props.canDraw} onClick={props.onClear} className="text-destructive hover:bg-destructive/15">
            Clear
          </Button>

          {props.isHost && (
            <>
              <div className="mx-1 h-6 w-px bg-border/50" />
              <div className="flex items-center gap-1">
                {ACCESS_MODES.map(({ value, label }) => (
                  <Button
                    key={value}
                    variant={props.accessMode === value ? "secondary" : "ghost"}
                    size="sm"
                    disabled={!props.isSessionActive}
                    onClick={() => props.onAccessModeChange(value)}
                    className={cn(props.accessMode === value && "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 dark:text-amber-400")}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </>
          )}

          {!props.isSessionActive && (
            <>
              <div className="mx-1 h-6 w-px bg-border/50" />
              <div className="animate-pulse px-2 text-xs font-medium text-muted-foreground">Connecting...</div>
            </>
          )}
        </div>

        <div className="mx-1 h-6 w-px bg-border/50" />

        {/* Close Section */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" onClick={props.onClose} className="rounded-full hover:bg-destructive/15 hover:text-destructive">
                <Cancel01Icon className="size-4" />
              </Button>
            }
          />
          <TooltipContent side="top" sideOffset={12} className="font-medium">
            Close annotations
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
});

ScreenAnnotationsToolbar.displayName = "ScreenAnnotationsToolbar";
