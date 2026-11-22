import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import Camera01Icon from "@hugeicons/core-free-icons/Camera01Icon";
import CircleIcon from "@hugeicons/core-free-icons/CircleIcon";
import Cursor01Icon from "@hugeicons/core-free-icons/Cursor01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import Eraser01Icon from "@hugeicons/core-free-icons/Eraser01Icon";
import HighlighterIcon from "@hugeicons/core-free-icons/HighlighterIcon";
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import Redo02Icon from "@hugeicons/core-free-icons/Redo02Icon";
import SquareIcon from "@hugeicons/core-free-icons/SquareIcon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import TextFontIcon from "@hugeicons/core-free-icons/TextFontIcon";
import Undo02Icon from "@hugeicons/core-free-icons/Undo02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ScreenAnnotationCommand } from "@q9labsai/chalk-client";
import { useId, type ComponentProps, type ReactNode } from "react";
import { ChalkPopover, ChalkTooltip } from "../chalk-ui";
import type { AnnotationBrush, AnnotationStamp, AnnotationTool } from "./model";

const tools = [
  { tool: "pointer", label: "Laser pointer", icon: Cursor01Icon },
  { tool: "pen", label: "Pen", icon: PencilEdit02Icon },
  { tool: "highlighter", label: "Highlighter", icon: HighlighterIcon },
  { tool: "line", label: "Line", icon: MinusSignIcon },
  { tool: "arrow", label: "Arrow", icon: ArrowUpRight01Icon },
  { tool: "box", label: "Box", icon: SquareIcon },
  { tool: "circle", label: "Circle", icon: CircleIcon },
  { tool: "text", label: "Text and notes", icon: TextFontIcon },
  { tool: "stamp", label: "Stamp", icon: StarIcon },
  { tool: "eraser", label: "Eraser", icon: Eraser01Icon },
] satisfies readonly { tool: AnnotationTool; label: string; icon: ComponentProps<typeof HugeiconsIcon>["icon"] }[];

const stamps = [
  { value: "check", glyph: "✓", label: "Check" },
  { value: "cross", glyph: "×", label: "Cross" },
  { value: "star", glyph: "★", label: "Star" },
  { value: "question", glyph: "?", label: "Question" },
  { value: "heart", glyph: "♥", label: "Heart" },
] satisfies readonly { value: AnnotationStamp; glyph: string; label: string }[];

export interface ScreenAnnotationToolbarProps {
  readonly brush: AnnotationBrush;
  readonly defaultColor: string;
  readonly enabled: boolean;
  readonly busy?: boolean;
  readonly canEdit: boolean;
  readonly canModerate: boolean;
  readonly onBrushChange: (brush: AnnotationBrush) => void;
  readonly onCommand: (command: ScreenAnnotationCommand) => void;
  readonly onSave?: () => void;
  readonly onDownload?: () => void;
}

export function ScreenAnnotationToolbar({ brush, defaultColor, enabled, busy, canEdit, canModerate, onBrushChange, onCommand, onSave, onDownload }: ScreenAnnotationToolbarProps): React.JSX.Element {
  const colorId = useId();
  const widthId = useId();
  const paint = brush.color ?? defaultColor;
  return (
    <div role="toolbar" aria-label="Annotation tools" data-part="screen-annotation-toolbar" className="chalk-ann-bar">
      {enabled ? (
        <>
          <ChalkPopover
            label="Ink colour and width"
            side="top"
            trigger={
              <button type="button" className="chalk-ann-btn" aria-label="Ink colour and width">
                <span aria-hidden="true" className="chalk-ann-dot" style={{ backgroundColor: paint }} />
              </button>
            }
          >
            <div className="chalk-ann-panel">
              <div className="grid gap-2">
                <div className="chalk-ann-row-between">
                  <label htmlFor={colorId} className="chalk-ann-heading">
                    Ink colour
                  </label>
                  <input id={colorId} type="color" value={paint} onChange={(event) => onBrushChange({ ...brush, color: event.target.value })} />
                </div>
                <button type="button" className="chalk-ann-small" onClick={() => onBrushChange({ ...brush, color: undefined })}>
                  Use my colour
                </button>
              </div>
              <label htmlFor={widthId} className="chalk-ann-slider">
                <span className="chalk-ann-heading">Stroke width</span>
                <input id={widthId} type="range" min={32} max={3277} step={1} value={brush.width} onChange={(event) => onBrushChange({ ...brush, width: event.target.valueAsNumber })} />
              </label>
            </div>
          </ChalkPopover>
          <span aria-hidden="true" className="chalk-ann-sep" />
          {tools.map(({ tool, label, icon }) => {
            const glyph = <HugeiconsIcon icon={icon} size={17} aria-hidden="true" />;
            return tool === "stamp" ? (
              <ChalkPopover
                key={tool}
                label="Choose stamp"
                side="top"
                trigger={
                  <button type="button" aria-label="Stamps" className="chalk-ann-btn" aria-pressed={brush.tool === tool}>
                    {glyph}
                  </button>
                }
              >
                <div className="chalk-ann-stamps" role="group" aria-label="Choose stamp">
                  {stamps.map((stamp) => (
                    <button key={stamp.value} type="button" className="chalk-ann-stamp" aria-label={stamp.label + " stamp"} aria-pressed={brush.tool === tool && brush.stamp === stamp.value} onClick={() => onBrushChange({ ...brush, tool, stamp: stamp.value })}>
                      {stamp.glyph}
                    </button>
                  ))}
                </div>
              </ChalkPopover>
            ) : (
              <AnnotationButton key={tool} label={label} pressed={brush.tool === tool} onClick={() => onBrushChange({ ...brush, tool })}>
                {glyph}
              </AnnotationButton>
            );
          })}
          <span aria-hidden="true" className="chalk-ann-sep" />
          <button type="button" aria-label="Keep new marks" aria-pressed={brush.keep} className="chalk-ann-btn" onClick={() => onBrushChange({ ...brush, keep: !brush.keep })}>
            {brush.keep ? "Keep" : "Fade"}
          </button>
        </>
      ) : null}
      {enabled ? <span aria-hidden="true" className="chalk-ann-sep" /> : null}
      {canEdit ? (
        <>
          <AnnotationButton label="Undo mark" onClick={() => onCommand({ kind: "undo" })}>
            <HugeiconsIcon icon={Undo02Icon} size={17} aria-hidden="true" />
          </AnnotationButton>
          <AnnotationButton label="Redo mark" onClick={() => onCommand({ kind: "redo" })}>
            <HugeiconsIcon icon={Redo02Icon} size={17} aria-hidden="true" />
          </AnnotationButton>
          <span aria-hidden="true" className="chalk-ann-sep" />
        </>
      ) : null}
      {canModerate ? (
        <ChalkPopover
          label="Clear marks"
          side="top"
          trigger={
            <button type="button" aria-label="Clear marks" className="chalk-ann-btn">
              <HugeiconsIcon icon={Delete02Icon} size={17} aria-hidden="true" />
            </button>
          }
        >
          <div className="chalk-ann-panel">
            <button type="button" className="chalk-ann-small" onClick={() => onCommand({ kind: "clear", scope: { kind: "mine" } })}>
              Clear my marks
            </button>
            <button type="button" className="chalk-ann-small" onClick={() => onCommand({ kind: "clear", scope: { kind: "all" } })}>
              Clear all marks
            </button>
          </div>
        </ChalkPopover>
      ) : (
        <AnnotationButton label="Clear my marks" onClick={() => onCommand({ kind: "clear", scope: { kind: "mine" } })}>
          <HugeiconsIcon icon={Delete02Icon} size={17} aria-hidden="true" />
        </AnnotationButton>
      )}
      {onSave ? (
        <AnnotationButton label="Save frame to board" disabled={busy} onClick={onSave}>
          <HugeiconsIcon icon={Camera01Icon} size={17} aria-hidden="true" />
        </AnnotationButton>
      ) : null}
      {onDownload ? (
        <AnnotationButton label="Download annotated PNG" disabled={busy} onClick={onDownload}>
          <HugeiconsIcon icon={Download01Icon} size={17} aria-hidden="true" />
        </AnnotationButton>
      ) : null}
    </div>
  );
}

function AnnotationButton({ label, pressed, disabled, onClick, children }: { readonly label: string; readonly pressed?: boolean; readonly disabled?: boolean; readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <ChalkTooltip
      trigger={
        <button type="button" className="chalk-ann-btn" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
          {children}
        </button>
      }
    >
      {label}
    </ChalkTooltip>
  );
}
