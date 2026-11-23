import DragDropVerticalIcon from "@hugeicons/core-free-icons/DragDropVerticalIcon";
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { ChalkPopover, ChalkSegmentedControl, ChalkTooltip } from "../chalk-ui";
import { isArrowKey, layoutAfterArrow, layoutAtPoint, saveSharerLayout, type SharerEdge, type SharerLayout, type SharerLook } from "./sharer-layout";

type OffsetStyle = CSSProperties & { "--o": number };

const looks = [
  { value: "island", label: "Island" },
  { value: "pill", label: "Pill" },
] satisfies readonly { value: SharerLook; label: string }[];

const edgeLabels = [
  { edge: "top", label: "Top" },
  { edge: "left", label: "Left" },
  { edge: "right", label: "Right" },
  { edge: "bottom", label: "Bottom" },
] satisfies readonly { edge: SharerEdge; label: string }[];

/** The sharer's own controls: drag them to any edge of the share, or pick the look they take. */
export function AnnotationSharerControl({ dockRef, layout, onLayout, children }: { readonly dockRef: RefObject<HTMLDivElement | null>; readonly layout: SharerLayout; readonly onLayout: (layout: SharerLayout) => void; readonly children: ReactNode }) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(layout);
  latest.current = layout;

  const commit = (next: SharerLayout) => {
    latest.current = next;
    onLayout(next);
    saveSharerLayout(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const box = dockRef.current?.getBoundingClientRect();
    if (!dragging || !box || box.width === 0 || box.height === 0) return;
    onLayout(layoutAtPoint(latest.current, { x: event.clientX, y: event.clientY }, box));
  };
  const onPointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    saveSharerLayout(latest.current);
  };
  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isArrowKey(event.key)) return;
    event.preventDefault();
    commit(layoutAfterArrow(layout, event.key));
  };
  const position: OffsetStyle = { "--o": layout.offset };
  return (
    <div role="group" aria-label="Sharing controls" className="chalk-ann-sharer" data-look={layout.look} data-edge={layout.edge} data-dragging={dragging ? "" : undefined} style={position}>
      <ChalkTooltip
        trigger={
          <button type="button" className="chalk-ann-btn chalk-ann-grip" aria-label="Move sharing controls" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onKeyDown={onGripKey}>
            <HugeiconsIcon icon={DragDropVerticalIcon} size={16} aria-hidden="true" />
          </button>
        }
      >
        Drag to move, or use the arrow keys
      </ChalkTooltip>
      <span aria-hidden="true" className="chalk-ann-sep" />
      {children}
      <span aria-hidden="true" className="chalk-ann-sep" />
      <ChalkPopover
        label="Control layout"
        side={layout.edge === "bottom" ? "top" : "bottom"}
        tooltip="Control layout"
        trigger={
          <button type="button" className="chalk-ann-btn" aria-label="Control layout">
            <HugeiconsIcon icon={Settings02Icon} size={16} aria-hidden="true" />
          </button>
        }
      >
        <div className="chalk-ann-panel">
          <div className="grid gap-1.5">
            <p className="chalk-ann-heading">Look</p>
            <ChalkSegmentedControl label="Look" size="compact" value={layout.look} options={looks} onValueChange={(look) => commit({ ...layout, look })} />
          </div>
          <div className="grid gap-1.5">
            <p className="chalk-ann-heading">Move to</p>
            <div className="chalk-ann-edge-grid">
              {edgeLabels.map(({ edge, label }) => (
                <button key={edge} type="button" className="chalk-ann-small" data-tone={layout.edge === edge ? "solid" : undefined} style={{ gridArea: edge }} aria-pressed={layout.edge === edge} onClick={() => commit({ ...layout, edge })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </ChalkPopover>
    </div>
  );
}
