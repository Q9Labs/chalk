import type { ScreenAnnotationItem } from "@q9labs/chalk-core";
import { memo } from "react";

const VIEWBOX_SIZE = 1000;

const toUnit = (value: number) => Math.max(0, Math.min(1, value)) * VIEWBOX_SIZE;

const buildPathData = (points: { x: number; y: number }[]) => {
  if (points.length === 0) {
    return "";
  }

  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${toUnit(point.x)} ${toUnit(point.y)}`).join(" ");
};

const renderItem = (item: ScreenAnnotationItem) => {
  if (item.deleted) {
    return null;
  }

  if (item.type === "freehand") {
    return <path key={item.id} d={buildPathData(item.points)} fill="none" stroke={item.style.color} strokeLinecap="round" strokeLinejoin="round" strokeOpacity={item.style.opacity ?? (item.tool === "highlighter" ? 0.35 : 1)} strokeWidth={item.style.strokeWidth * 6} />;
  }

  if (item.type === "shape") {
    const startX = toUnit(item.start.x);
    const startY = toUnit(item.start.y);
    const endX = toUnit(item.end.x);
    const endY = toUnit(item.end.y);
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    const commonProps = {
      fill: "none",
      stroke: item.style.color,
      strokeOpacity: item.style.opacity ?? 1,
      strokeWidth: item.style.strokeWidth * 4,
    };

    if (item.shape === "rectangle") {
      return <rect key={item.id} x={x} y={y} width={width} height={height} rx={14} {...commonProps} />;
    }

    if (item.shape === "ellipse") {
      return <ellipse key={item.id} cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} {...commonProps} />;
    }

    return <line key={item.id} x1={startX} y1={startY} x2={endX} y2={endY} markerEnd={item.shape === "arrow" ? "url(#chalk-annotation-arrow)" : undefined} style={{ color: item.style.color }} {...commonProps} />;
  }

  return (
    <text key={item.id} x={toUnit(item.position.x)} y={toUnit(item.position.y)} fill={item.style.color} fillOpacity={item.style.opacity ?? 1} fontSize={item.style.fontSize * 3} fontWeight={600}>
      {item.text}
    </text>
  );
};

export interface ScreenAnnotationsSvgProps {
  items: readonly ScreenAnnotationItem[];
  draftItem: ScreenAnnotationItem | null;
  interactive: boolean;
  onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
  onPointerLeave: () => void;
}

export const ScreenAnnotationsSvg = memo(({ items, draftItem, interactive, onPointerDown, onPointerMove, onPointerUp, onPointerLeave }: ScreenAnnotationsSvgProps) => (
  <svg
    className="absolute inset-0 h-full w-full"
    viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
    preserveAspectRatio="none"
    onPointerDown={interactive ? onPointerDown : undefined}
    onPointerMove={interactive ? onPointerMove : undefined}
    onPointerUp={interactive ? onPointerUp : undefined}
    onPointerLeave={interactive ? onPointerLeave : undefined}
    style={{ pointerEvents: interactive ? "auto" : "none" }}
  >
    <defs>
      <marker id="chalk-annotation-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto-start-reverse">
        <path d="M 0 0 L 12 6 L 0 12 z" fill="currentColor" />
      </marker>
    </defs>
    {items.map(renderItem)}
    {draftItem ? renderItem(draftItem) : null}
  </svg>
));

ScreenAnnotationsSvg.displayName = "ScreenAnnotationsSvg";
