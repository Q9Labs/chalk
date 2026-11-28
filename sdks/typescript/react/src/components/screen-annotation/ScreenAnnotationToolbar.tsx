import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import CircleIcon from "@hugeicons/core-free-icons/CircleIcon";
import Cursor01Icon from "@hugeicons/core-free-icons/Cursor01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import Eraser01Icon from "@hugeicons/core-free-icons/Eraser01Icon";
import HighlighterIcon from "@hugeicons/core-free-icons/HighlighterIcon";
import Image01Icon from "@hugeicons/core-free-icons/Image01Icon";
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import Redo02Icon from "@hugeicons/core-free-icons/Redo02Icon";
import ShapesIcon from "@hugeicons/core-free-icons/ShapesIcon";
import SquareIcon from "@hugeicons/core-free-icons/SquareIcon";
import TextFontIcon from "@hugeicons/core-free-icons/TextFontIcon";
import Undo02Icon from "@hugeicons/core-free-icons/Undo02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { ANNOTATION_SWATCHES } from "@q9labsai/chalk-screen-annotation";
import type { ScreenAnnotationCommand } from "@q9labsai/chalk-client";
import { useId, type ComponentProps, type ReactNode } from "react";
import { ChalkMenu, ChalkMenuPrimitive as Menu, ChalkPopover, ChalkTooltip } from "../chalk-ui";
import { penWidth, type AnnotationBrush, type AnnotationStamp, type AnnotationTool } from "./model";

type Icon = ComponentProps<typeof HugeiconsIcon>["icon"];

const shapes = [
  { tool: "line", label: "Line", icon: MinusSignIcon },
  { tool: "arrow", label: "Arrow", icon: ArrowUpRight01Icon },
  { tool: "box", label: "Box", icon: SquareIcon },
  { tool: "circle", label: "Circle", icon: CircleIcon },
] satisfies readonly { tool: AnnotationTool; label: string; icon: Icon }[];

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
  readonly phone: boolean;
  readonly busy?: boolean;
  readonly onBrushChange: (brush: AnnotationBrush) => void;
  readonly onCommand: (command: ScreenAnnotationCommand) => void;
  readonly onSave?: () => void;
  readonly onDownload?: () => void;
  readonly onDone: () => void;
}

/** The one compact bar a person draws with. A phone drops the highlighter, text and undo. */
export function ScreenAnnotationToolbar({ brush, defaultColor, phone, busy, onBrushChange, onCommand, onSave, onDownload, onDone }: ScreenAnnotationToolbarProps): React.JSX.Element {
  const paint = brush.color ?? defaultColor;
  const pick = (tool: AnnotationTool) => onBrushChange({ ...brush, tool, width: penWidth(tool) });
  const shape = shapes.find((entry) => entry.tool === brush.tool);
  const widthId = useId();
  return (
    <div role="toolbar" aria-label="Drawing tools" data-part="screen-annotation-toolbar" className="chalk-ann-bar">
      <ToolButton label="Laser pointer" pressed={brush.tool === "pointer"} onClick={() => pick("pointer")} icon={Cursor01Icon} />
      <ToolButton label="Pen" pressed={brush.tool === "pen"} onClick={() => pick("pen")} icon={PencilEdit02Icon} />
      {phone ? null : <ToolButton label="Highlighter" pressed={brush.tool === "highlighter"} onClick={() => pick("highlighter")} icon={HighlighterIcon} />}
      <ChalkPopover
        label="Shapes"
        side="top"
        trigger={
          <button type="button" className="chalk-ann-btn" aria-label="Shapes" aria-pressed={Boolean(shape) || brush.tool === "stamp"}>
            <HugeiconsIcon icon={shape?.icon ?? ShapesIcon} size={18} aria-hidden="true" />
          </button>
        }
      >
        <div className="chalk-ann-stamps" role="group" aria-label="Shapes">
          {shapes.map(({ tool, label, icon }) => (
            <button key={tool} type="button" className="chalk-ann-stamp" aria-label={label} aria-pressed={brush.tool === tool} onClick={() => pick(tool)}>
              <HugeiconsIcon icon={icon} size={18} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="chalk-ann-stamps" role="group" aria-label="Stamps">
          {stamps.map(({ value, glyph, label }) => (
            <button key={value} type="button" className="chalk-ann-stamp" aria-label={`${label} stamp`} aria-pressed={brush.tool === "stamp" && brush.stamp === value} onClick={() => onBrushChange({ ...brush, tool: "stamp", width: penWidth("stamp"), stamp: value })}>
              {glyph}
            </button>
          ))}
        </div>
      </ChalkPopover>
      {phone ? null : <ToolButton label="Text" pressed={brush.tool === "text"} onClick={() => pick("text")} icon={TextFontIcon} />}
      <ToolButton label="Eraser" pressed={brush.tool === "eraser"} onClick={() => pick("eraser")} icon={Eraser01Icon} />
      <span aria-hidden="true" className="chalk-ann-sep" />
      <ChalkPopover
        label="Colour"
        side="top"
        trigger={
          <button type="button" className="chalk-ann-btn" aria-label="Colour">
            <span aria-hidden="true" className="chalk-ann-dot" style={{ backgroundColor: paint }} />
          </button>
        }
      >
        <div className="chalk-ann-stamps" role="group" aria-label="Colour">
          {[{ label: "My colour", value: defaultColor }, ...ANNOTATION_SWATCHES].map(({ label, value }) => (
            <button key={label} type="button" className="chalk-ann-stamp" aria-label={label} aria-pressed={paint === value} onClick={() => onBrushChange({ ...brush, color: value === defaultColor ? undefined : value })}>
              <span aria-hidden="true" className="chalk-ann-swatch" style={{ backgroundColor: value }} />
            </button>
          ))}
        </div>
        <label htmlFor={widthId} className="chalk-ann-slider">
          <span className="chalk-ann-heading">Stroke width</span>
          <input id={widthId} type="range" min={32} max={3277} step={1} value={brush.width} onChange={(event) => onBrushChange({ ...brush, width: event.target.valueAsNumber })} />
        </label>
      </ChalkPopover>
      {phone ? null : <ToolButton label="Undo" onClick={() => onCommand({ kind: "undo" })} icon={Undo02Icon} />}
      <ChalkMenu
        side="top"
        trigger={
          <button type="button" className="chalk-ann-btn" aria-label="More">
            <HugeiconsIcon icon={MoreHorizontalIcon} size={18} aria-hidden="true" />
          </button>
        }
      >
        <Menu.CheckboxItem className="chalk-menu-item" checked={!brush.keep} onCheckedChange={(fade) => onBrushChange({ ...brush, keep: !fade })} closeOnClick={false}>
          <span>Marks fade after a few seconds</span>
          <span className="chalk-shell-menu-switch" aria-hidden="true">
            <span className="chalk-switch" aria-checked={!brush.keep}>
              <span />
            </span>
          </span>
        </Menu.CheckboxItem>
        {phone ? (
          <Menu.Item className="chalk-menu-item" onClick={() => onCommand({ kind: "undo" })}>
            <HugeiconsIcon icon={Undo02Icon} size={18} aria-hidden="true" />
            Undo
          </Menu.Item>
        ) : null}
        <Menu.Item className="chalk-menu-item" onClick={() => onCommand({ kind: "redo" })}>
          <HugeiconsIcon icon={Redo02Icon} size={18} aria-hidden="true" />
          Redo
        </Menu.Item>
        <Menu.Item className="chalk-menu-item" onClick={() => onCommand({ kind: "clear", scope: { kind: "mine" } })}>
          <HugeiconsIcon icon={Delete02Icon} size={18} aria-hidden="true" />
          Clear my marks
        </Menu.Item>
        {onSave || onDownload ? <Menu.Separator className="chalk-shell-menu-separator" /> : null}
        {onSave ? (
          <Menu.Item className="chalk-menu-item chalk-shell-source" disabled={busy} onClick={onSave}>
            <HugeiconsIcon icon={Image01Icon} size={18} aria-hidden="true" />
            <span className="chalk-shell-device-label">
              <span>Save to board</span>
              <small>Screen and marks as one image</small>
            </span>
          </Menu.Item>
        ) : null}
        {onDownload ? (
          <Menu.Item className="chalk-menu-item" disabled={busy} onClick={onDownload}>
            <HugeiconsIcon icon={Download01Icon} size={18} aria-hidden="true" />
            Download image
          </Menu.Item>
        ) : null}
      </ChalkMenu>
      <button type="button" className="chalk-ann-btn" data-tone="primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function ToolButton({ label, icon, pressed, onClick }: { readonly label: string; readonly icon: Icon; readonly pressed?: boolean; readonly onClick: () => void }): ReactNode {
  return (
    <ChalkTooltip
      trigger={
        <button type="button" className="chalk-ann-btn" aria-label={label} aria-pressed={pressed} onClick={onClick}>
          <HugeiconsIcon icon={icon} size={18} aria-hidden="true" />
        </button>
      }
    >
      {label}
    </ChalkTooltip>
  );
}
