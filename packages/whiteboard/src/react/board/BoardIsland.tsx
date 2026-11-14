import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { usePrefersReducedMotion } from "./useMediaQuery";
import { ChalkMenu, ChalkMenuItem, ChalkPopover, ChalkTooltip } from "./controls";
import { BoardIcon, GripIcon } from "./BoardIcon";
import { ISLAND_PLACES, PEN_COLORS, PEN_WIDTHS, SHAPES, checkInk, strokeChip, strokePreview, strokeTarget, surfaceFill, surfaceInk, type BoardSurface, type BoardTool, type CallTheme, type IslandPlace, type PenColor, type PenWidth, type ShapeTool } from "./board-model";
import { TOOL_GROUPS, TRAY_COLUMNS, TRAY_TOOLS, toolEntry, type ToolEntry } from "./board-tools";

export type IslandProps = {
  readonly tool: BoardTool;
  readonly shape: ShapeTool;
  readonly onTool: (tool: BoardTool) => void;
  readonly color: PenColor;
  readonly width: PenWidth;
  readonly onColor: (color: PenColor) => void;
  readonly onWidth: (width: PenWidth) => void;
  readonly surface: BoardSurface;
  readonly theme: CallTheme;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly place: IslandPlace;
  readonly onPlace: (place: IslandPlace, announce: boolean) => void;
  readonly compact: boolean;
  /** An empty phone board shows one launcher in place of the full island. */
  readonly idle?: boolean;
  readonly primaryToolsFirst?: boolean;
};

const DRAG_START_PX = 4;

function Tip({ label, keyName, children }: { readonly label: string; readonly keyName?: string; readonly children: React.ReactElement }) {
  return (
    <ChalkTooltip trigger={children}>
      {label}
      {keyName ? <kbd className="chalk-board-kbd">{keyName}</kbd> : null}
    </ChalkTooltip>
  );
}

function ToolButton({ entry, active, onTool }: { readonly entry: ToolEntry; readonly active: boolean; readonly onTool: (tool: BoardTool) => void }) {
  return (
    <Tip label={entry.label} keyName={entry.key}>
      <button type="button" className="chalk-board-tool" aria-label={entry.label} aria-keyshortcuts={entry.key} aria-pressed={active} onClick={() => onTool(entry.tool)}>
        <BoardIcon name={entry.glyph} />
      </button>
    </Tip>
  );
}

function ShapesButton({ tool, shape, onTool, side }: { readonly tool: BoardTool; readonly shape: ShapeTool; readonly onTool: (tool: BoardTool) => void; readonly side: "top" | "bottom" }) {
  const active = SHAPES.some((entry) => entry.id === tool);
  return (
    <ChalkMenu
      side={side}
      trigger={
        <button type="button" className="chalk-board-tool" aria-label="Shapes" aria-keyshortcuts="R" aria-pressed={active}>
          <BoardIcon name={shape} />
          <span className="chalk-board-tool-notch" aria-hidden="true" />
        </button>
      }
    >
      {SHAPES.map((entry) => (
        <ChalkMenuItem key={entry.id} checked={tool === entry.id} onClick={() => onTool(entry.id)}>
          <BoardIcon name={entry.id} size={18} />
          {entry.label}
          <kbd className="chalk-board-menu-kbd">{entry.key}</kbd>
        </ChalkMenuItem>
      ))}
    </ChalkMenu>
  );
}

type StrokeProps = Pick<IslandProps, "tool" | "color" | "width" | "surface" | "theme" | "onColor" | "onWidth">;

function StrokePanel({ tool, color, width, surface, theme, onColor, onWidth }: StrokeProps) {
  const preview = strokePreview(tool, color, width, surface, theme);
  return (
    <div className="chalk-board-colors">
      <div className="chalk-board-stroke-preview" style={{ background: surfaceFill(surface, theme), color: surfaceInk(surface, theme) }}>
        <span className="chalk-board-stroke-target">{strokeTarget(tool)}</span>
        <svg viewBox="0 0 264 64" fill="none" strokeLinecap="round" aria-hidden="true">
          <path d="M28 40c22-26 44-26 66 0s44 18 70-4 46-12 72-2" stroke={preview.stroke} strokeWidth={preview.width} strokeOpacity={preview.opacity} />
        </svg>
      </div>
      <div role="radiogroup" aria-label="Colour" className="chalk-board-swatches">
        {PEN_COLORS.map((entry) => {
          const disc = strokeChip(entry.id, width, surface, theme).disc;
          return (
            <button key={entry.id} type="button" role="radio" aria-checked={color === entry.id} aria-label={entry.label} className="chalk-board-swatch" onClick={() => onColor(entry.id)}>
              <i style={{ background: disc, color: checkInk(disc) }}>{color === entry.id ? <BoardIcon name="check" size={16} /> : null}</i>
            </button>
          );
        })}
      </div>
      <div role="radiogroup" aria-label="Stroke width" className="chalk-board-swatches chalk-board-widths">
        {PEN_WIDTHS.map((entry) => (
          <button key={entry.id} type="button" role="radio" aria-checked={width === entry.id} aria-label={entry.label} className="chalk-board-width" onClick={() => onWidth(entry.id)}>
            <i style={{ height: entry.units }} />
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One pill showing the colour and the width together, so it never reads as a tool that is switched on. It opens the colour and width, on a phone too. */
function StrokeChip({ side, ...props }: StrokeProps & { readonly side: "top" | "bottom" }) {
  const chip = strokeChip(props.color, props.width, props.surface, props.theme);
  return (
    <ChalkPopover
      label={`${strokeTarget(props.tool)} colour and width`}
      tooltip="Colour and width"
      side={side}
      className="chalk-board-color-popover"
      trigger={
        <button type="button" className="chalk-board-stroke" aria-label={chip.label}>
          <span className="chalk-board-stroke-disc" style={{ background: chip.disc }} />
          <span className="chalk-board-stroke-bar" style={{ height: chip.bar }} />
        </button>
      }
    >
      <StrokePanel {...props} />
    </ChalkPopover>
  );
}

/** The phone's tool button: the current tool, and a tray with every tool and its name behind it. */
function ToolTray({ tool, onTool }: { readonly tool: BoardTool; readonly onTool: (tool: BoardTool) => void }) {
  const [open, setOpen] = useState(false);
  const current = toolEntry(tool);
  return (
    <ChalkPopover
      label="Tools"
      side="top"
      open={open}
      onOpenChange={setOpen}
      className="chalk-board-tray"
      trigger={
        <button type="button" className="chalk-board-tool" data-current aria-label={`Tools: ${current.label}`}>
          <BoardIcon name={current.glyph} />
          <span className="chalk-board-tool-notch" aria-hidden="true" />
        </button>
      }
    >
      <div className="chalk-board-tray-grid" style={{ gridTemplateColumns: `repeat(${TRAY_COLUMNS}, 1fr)` }}>
        {TRAY_TOOLS.map((entry) => (
          <button
            key={entry.tool}
            type="button"
            className="chalk-board-tray-tool"
            aria-pressed={tool === entry.tool}
            onClick={() => {
              onTool(entry.tool);
              setOpen(false);
            }}
          >
            <BoardIcon name={entry.glyph} />
            {entry.label}
          </button>
        ))}
      </div>
    </ChalkPopover>
  );
}

/** Arrow keys move between the island's buttons; Tab leaves the island. */
function roveFocus(event: KeyboardEvent<HTMLElement>, vertical: boolean) {
  const back = vertical ? "ArrowUp" : "ArrowLeft";
  const forward = vertical ? "ArrowDown" : "ArrowRight";
  if (event.key !== back && event.key !== forward && event.key !== "Home" && event.key !== "End") return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const index = buttons.findIndex((button) => button === document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  event.stopPropagation();
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === forward ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

function Separator() {
  return <span className="chalk-board-separator" aria-hidden="true" />;
}

function HistoryButtons({ canUndo, canRedo, onUndo, onRedo }: Pick<IslandProps, "canUndo" | "canRedo" | "onUndo" | "onRedo">) {
  return (
    <>
      <Tip label="Undo" keyName="⌘Z">
        <button type="button" className="chalk-board-tool" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
          <BoardIcon name="undo" />
        </button>
      </Tip>
      <Tip label="Redo" keyName="⇧⌘Z">
        <button type="button" className="chalk-board-tool" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
          <BoardIcon name="redo" />
        </button>
      </Tip>
    </>
  );
}

function ToolRow({ tool, shape, onTool, place, canUndo, canRedo, onUndo, onRedo, primaryToolsFirst, color, width, surface, theme, onColor, onWidth }: IslandProps) {
  const primaryTools = ["pen", "text", "note", "eraser"];
  const entries = TOOL_GROUPS.flat();
  const stroke = <StrokeChip tool={tool} color={color} width={width} surface={surface} theme={theme} onColor={onColor} onWidth={onWidth} side={place === "top" ? "bottom" : "top"} />;
  const shapes = <ShapesButton tool={tool} shape={shape} onTool={onTool} side={place === "top" ? "bottom" : "top"} />;
  const button = (entry: (typeof entries)[number]) => <ToolButton key={entry.tool} entry={entry} active={tool === entry.tool} onTool={onTool} />;
  const groups: ReactNode[] = TOOL_GROUPS.map((group, index) => (
    <span key={index} className="chalk-board-group">
      {group.map((entry) => (
        <ToolButton key={entry.tool} entry={entry} active={tool === entry.tool} onTool={onTool} />
      ))}
      {index === 1 ? shapes : null}
    </span>
  ));
  return (
    <>
      {primaryToolsFirst
        ? entries
            .filter((entry) => primaryTools.includes(entry.tool))
            .map((entry) => (
              <span key={entry.tool} className="chalk-board-group">
                {button(entry)}
                {entry.tool === "pen" ? shapes : null}
              </span>
            ))
        : groups.flatMap((group, index) => [index > 0 ? <Separator key={`s${index}`} /> : null, group])}
      <Separator />
      {primaryToolsFirst ? (
        <>
          {stroke}
          <Separator />
        </>
      ) : null}
      <HistoryButtons canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} />
      {primaryToolsFirst ? (
        <>
          <Separator />
          {entries.filter((entry) => !primaryTools.includes(entry.tool)).map(button)}
        </>
      ) : (
        <>
          <Separator />
          {stroke}
        </>
      )}
    </>
  );
}

function nearestPlace(board: DOMRect, x: number, y: number): IslandPlace {
  const distances: Record<IslandPlace, number> = { left: x - board.left, bottom: board.bottom - y, top: y - board.top };
  return ISLAND_PLACES.map((entry) => entry.id).reduce((best, place) => (distances[place] < distances[best] ? place : best));
}

/** The tool island: a pill of tools that docks at the bottom, the top or the left, or, when compact, the current tool, the stroke chip and undo and redo. */
export function BoardIsland(props: IslandProps) {
  const { place, onPlace, compact } = props;
  const island = useRef<HTMLDivElement>(null);
  const tabStop = useRef<HTMLButtonElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const [drag, setDrag] = useState<{ readonly x: number; readonly y: number; readonly near: IslandPlace } | null>(null);
  const dropRect = useRef<DOMRect | null>(null);
  const [expanded, setExpanded] = useState(false);
  const focusOnExpand = useRef(false);

  useLayoutEffect(() => {
    const buttons = [...(island.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const stop = buttons.find((button) => button === tabStop.current && !button.disabled) ?? buttons.find((button) => !button.disabled);
    tabStop.current = stop ?? null;
    for (const button of buttons) button.tabIndex = button === stop ? 0 : -1;
  });

  // The launcher unmounts when it opens the tools, so focus moves to the first tool instead of falling to the page.
  useLayoutEffect(() => {
    if (!expanded || !focusOnExpand.current) return;
    focusOnExpand.current = false;
    island.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [expanded]);

  useLayoutEffect(() => {
    const element = island.current;
    const from = dropRect.current;
    dropRect.current = null;
    if (!element || !from || reduced) return;
    const to = element.getBoundingClientRect();
    element.animate(
      [
        { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, opacity: 0.85 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 300, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }, [place, reduced]);

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const board = island.current?.parentElement;
    if (!board || event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const dx = next.clientX - start.x;
      const dy = next.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_START_PX) return;
      moved = true;
      setDrag({ x: dx, y: dy, near: nearestPlace(board.getBoundingClientRect(), next.clientX, next.clientY) });
    };
    const end = (next: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (moved && next.type === "pointerup") {
        dropRect.current = island.current?.getBoundingClientRect() ?? null;
        onPlace(nearestPlace(board.getBoundingClientRect(), next.clientX, next.clientY), true);
      }
      setDrag(null);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };

  const gripKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey) return;
    const target: Partial<Record<string, IslandPlace>> = { ArrowLeft: "left", ArrowDown: "bottom", ArrowUp: "top" };
    const next = target[event.key];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== place) {
      dropRect.current = island.current?.getBoundingClientRect() ?? null;
      onPlace(next, true);
    }
  };

  const vertical = place === "left" && !compact;
  return (
    <>
      {drag ? ISLAND_PLACES.map((entry) => <div key={entry.id} className="chalk-board-dropzone" data-zone={entry.id} data-near={drag.near === entry.id || undefined} aria-hidden="true" />) : null}
      <div
        ref={island}
        role="toolbar"
        aria-label="Drawing tools"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        className="chalk-board-island"
        data-place={compact ? "compact" : place}
        data-dragging={drag ? true : undefined}
        style={drag ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : undefined}
        onKeyDownCapture={(event) => {
          if (!event.altKey) roveFocus(event, vertical);
        }}
        onFocusCapture={(event) => {
          if (!(event.target instanceof HTMLButtonElement) || !event.currentTarget.contains(event.target)) return;
          tabStop.current = event.target;
          for (const button of event.currentTarget.querySelectorAll<HTMLButtonElement>("button")) button.tabIndex = button === event.target ? 0 : -1;
        }}
      >
        {compact && props.idle && !expanded ? (
          <button
            type="button"
            className="chalk-board-tool"
            data-current
            aria-label="Open drawing tools"
            aria-expanded={false}
            onClick={(event) => {
              focusOnExpand.current = event.currentTarget === document.activeElement;
              setExpanded(true);
            }}
          >
            <BoardIcon name={toolEntry(props.tool).glyph} />
          </button>
        ) : compact ? (
          <>
            <ToolTray tool={props.tool} onTool={props.onTool} />
            <StrokeChip tool={props.tool} color={props.color} width={props.width} surface={props.surface} theme={props.theme} onColor={props.onColor} onWidth={props.onWidth} side="top" />
            <Separator />
            <HistoryButtons canUndo={props.canUndo} canRedo={props.canRedo} onUndo={props.onUndo} onRedo={props.onRedo} />
          </>
        ) : (
          <>
            {!props.primaryToolsFirst ? (
              <Tip label="Move the tools">
                <button type="button" className="chalk-board-grip" aria-label="Move the tools. Use Alt and the arrow keys to dock them left, bottom or top." onPointerDown={startDrag} onKeyDown={gripKeys}>
                  <GripIcon />
                </button>
              </Tip>
            ) : null}
            <ToolRow {...props} />
          </>
        )}
      </div>
    </>
  );
}
