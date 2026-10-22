import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { usePrefersReducedMotion } from "./useMediaQuery";
import { ChalkMenu, ChalkMenuItem, ChalkPopover, ChalkTooltip } from "./controls";
import { BoardIcon, GripIcon, type BoardGlyph } from "./BoardIcon";
import { ISLAND_PLACES, PEN_COLORS, PEN_WIDTHS, SHAPES, penHex, type BoardSurface, type BoardTool, type CallTheme, type IslandPlace, type PenColor, type PenWidth, type ShapeTool } from "./board-model";

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
  readonly primaryToolsFirst?: boolean;
};

const TOOLS: readonly (readonly { readonly tool: BoardTool; readonly label: string; readonly key: string; readonly glyph: BoardGlyph }[])[] = [
  [
    { tool: "selection", label: "Select", key: "V", glyph: "select" },
    { tool: "hand", label: "Hand", key: "H", glyph: "hand" },
  ],
  [
    { tool: "pen", label: "Pen", key: "P", glyph: "pen" },
    { tool: "highlighter", label: "Highlighter", key: "U", glyph: "highlighter" },
  ],
  [
    { tool: "text", label: "Text", key: "T", glyph: "text" },
    { tool: "note", label: "Sticky note", key: "N", glyph: "note" },
  ],
  [
    { tool: "eraser", label: "Eraser", key: "E", glyph: "eraser" },
    { tool: "laser", label: "Laser pointer", key: "K", glyph: "laser" },
  ],
];

const LONG_PRESS_MS = 500;
const DRAG_START_PX = 4;

function Tip({ label, keyName, children }: { readonly label: string; readonly keyName?: string; readonly children: React.ReactElement }) {
  return (
    <ChalkTooltip trigger={children}>
      {label}
      {keyName ? <kbd className="chalk-board-kbd">{keyName}</kbd> : null}
    </ChalkTooltip>
  );
}

function ToolButton({ entry, active, onTool }: { readonly entry: (typeof TOOLS)[number][number]; readonly active: boolean; readonly onTool: (tool: BoardTool) => void }) {
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
          <BoardIcon name="chevron" size={9} className="chalk-board-tool-caret" />
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

function ColorPanel({ color, width, surface, theme, onColor, onWidth }: Pick<IslandProps, "color" | "width" | "surface" | "theme" | "onColor" | "onWidth">) {
  return (
    <div className="chalk-board-colors">
      <div role="radiogroup" aria-label="Colour" className="chalk-board-swatches">
        {PEN_COLORS.map((entry) => (
          <button key={entry.id} type="button" role="radio" aria-checked={color === entry.id} aria-label={entry.label} className="chalk-board-swatch" onClick={() => onColor(entry.id)}>
            <i style={{ background: penHex(entry.id, surface, theme) }} />
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Stroke width" className="chalk-board-swatches">
        {PEN_WIDTHS.map((entry) => (
          <button key={entry.id} type="button" role="radio" aria-checked={width === entry.id} aria-label={entry.label} className="chalk-board-width" onClick={() => onWidth(entry.id)}>
            <i style={{ height: entry.units }} />
          </button>
        ))}
      </div>
    </div>
  );
}

function ColorButton(props: Pick<IslandProps, "color" | "width" | "surface" | "theme" | "onColor" | "onWidth"> & { readonly open?: boolean; readonly onOpenChange?: (open: boolean) => void; readonly trigger?: React.ReactElement }) {
  const swatch = penHex(props.color, props.surface, props.theme);
  return (
    <ChalkPopover
      label="Colour and width"
      tooltip="Colour and width"
      open={props.open}
      onOpenChange={props.onOpenChange}
      className="chalk-board-color-popover"
      trigger={
        props.trigger ?? (
          <button type="button" className="chalk-board-tool" aria-label={`Colour: ${PEN_COLORS.find((entry) => entry.id === props.color)!.label}`}>
            <span className="chalk-board-tool-swatch" style={{ background: swatch }} />
          </button>
        )
      }
    >
      <ColorPanel {...props} />
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

function ToolRow({ tool, shape, onTool, place, canUndo, canRedo, onUndo, onRedo, compact, primaryToolsFirst, ...colors }: IslandProps & { readonly place: IslandPlace }) {
  const phone = compact && primaryToolsFirst;
  const primaryTools = ["pen", "text", "note", "eraser"];
  const entries = TOOLS.flat();
  const shapes = <ShapesButton tool={tool} shape={shape} onTool={onTool} side={place === "top" ? "bottom" : "top"} />;
  const button = (entry: (typeof entries)[number]) => <ToolButton key={entry.tool} entry={entry} active={tool === entry.tool} onTool={onTool} />;
  const groups: ReactNode[] = TOOLS.map((group, index) => (
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
          <ColorButton {...colors} />
          <Separator />
        </>
      ) : null}
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
      {phone ? (
        <>
          <Separator />
          {entries.filter((entry) => !primaryTools.includes(entry.tool)).map(button)}
        </>
      ) : primaryToolsFirst ? null : (
        <>
          <Separator />
          <ColorButton {...colors} />
        </>
      )}
    </>
  );
}

function nearestPlace(board: DOMRect, x: number, y: number): IslandPlace {
  const distances: Record<IslandPlace, number> = { left: x - board.left, bottom: board.bottom - y, top: y - board.top };
  return ISLAND_PLACES.map((entry) => entry.id).reduce((best, place) => (distances[place] < distances[best] ? place : best));
}

/** The tool island: a pill of tools that docks at the bottom, the top or the left, or one pen button when compact. */
export function BoardIsland(props: IslandProps) {
  const { place, onPlace, compact } = props;
  const island = useRef<HTMLDivElement>(null);
  const tabStop = useRef<HTMLButtonElement | null>(null);
  const reduced = usePrefersReducedMotion();
  const [drag, setDrag] = useState<{ readonly x: number; readonly y: number; readonly near: IslandPlace } | null>(null);
  const dropRect = useRef<DOMRect | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [colorsOpen, setColorsOpen] = useState(false);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; long: boolean }>({ long: false });

  useLayoutEffect(() => {
    const buttons = [...(island.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const stop = buttons.find((button) => button === tabStop.current && !button.disabled) ?? buttons.find((button) => !button.disabled);
    tabStop.current = stop ?? null;
    for (const button of buttons) button.tabIndex = button === stop ? 0 : -1;
  });

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

  if (compact && !expanded) {
    const cancelPress = () => clearTimeout(press.current.timer);
    return (
      <div ref={island} className="chalk-board-island" data-place="compact">
        <ColorButton
          {...props}
          open={colorsOpen}
          // Only a long press opens the colours; a tap opens the tool row.
          onOpenChange={(open) => {
            if (!open) setColorsOpen(false);
          }}
          trigger={
            <button
              type="button"
              className="chalk-board-tool"
              aria-label="Drawing tools"
              aria-expanded={false}
              onPointerDown={() => {
                press.current.long = false;
                press.current.timer = setTimeout(() => {
                  press.current.long = true;
                  setColorsOpen(true);
                }, LONG_PRESS_MS);
              }}
              onPointerUp={cancelPress}
              onPointerLeave={cancelPress}
              onContextMenu={(event) => event.preventDefault()}
              onClick={() => {
                if (!press.current.long) setExpanded(true);
              }}
            >
              <BoardIcon name="pen" />
              <span className="chalk-board-tool-dot" style={{ background: penHex(props.color, props.surface, props.theme) }} />
            </button>
          }
        />
      </div>
    );
  }

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
        data-place={compact ? "expanded" : place}
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
        {compact ? (
          <>
            <button type="button" className="chalk-board-tool" aria-label="Close drawing tools" onClick={() => setExpanded(false)}>
              <BoardIcon name="close" />
            </button>
            <Separator />
          </>
        ) : !props.primaryToolsFirst ? (
          <Tip label="Move the tools">
            <button type="button" className="chalk-board-grip" aria-label="Move the tools. Use Alt and the arrow keys to dock them left, bottom or top." onPointerDown={startDrag} onKeyDown={gripKeys}>
              <GripIcon />
            </button>
          </Tip>
        ) : null}
        <ToolRow {...props} place={compact ? "bottom" : place} />
      </div>
    </>
  );
}
