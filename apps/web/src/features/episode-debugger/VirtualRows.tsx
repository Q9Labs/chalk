import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type VirtualWindow = Readonly<{
  start: number;
  end: number;
  offset: number;
  totalHeight: number;
}>;

export const calculateVirtualWindow = (rowCount: number, rowHeight: number, viewportHeight: number, scrollTop: number, overscan = 4): VirtualWindow => {
  const visibleStart = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visibleEnd = Math.ceil((Math.max(0, scrollTop) + viewportHeight) / rowHeight);
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(rowCount, visibleEnd + overscan);
  return { start, end, offset: start * rowHeight, totalHeight: rowCount * rowHeight };
};

type VirtualRowsProps<T> = Readonly<{
  items: readonly T[];
  getKey: (item: T) => string;
  label: string;
  renderRow: (item: T, selected: boolean) => ReactNode;
  selectedKey?: string;
  onSelect: (item: T) => void;
  rowHeight?: number;
  viewportHeight?: number;
}>;

export function VirtualRows<T>({ items, getKey, label, renderRow, selectedKey, onSelect, rowHeight = 52, viewportHeight = 520 }: VirtualRowsProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => getKey(item) === selectedKey),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const window = useMemo(() => calculateVirtualWindow(items.length, rowHeight, viewportHeight, scrollTop), [items.length, rowHeight, viewportHeight, scrollTop]);

  useLayoutEffect(() => {
    if (selectedKey === undefined) return;
    const nextIndex = items.findIndex((item) => getKey(item) === selectedKey);
    if (nextIndex >= 0) setActiveIndex(nextIndex);
  }, [getKey, items, selectedKey]);

  const move = (nextIndex: number): void => {
    if (items.length === 0) return;
    const bounded = Math.max(0, Math.min(items.length - 1, nextIndex));
    setActiveIndex(bounded);
    const item = items[bounded];
    if (item) onSelect(item);
    const container = containerRef.current;
    if (!container) return;
    const top = bounded * rowHeight;
    if (top < container.scrollTop) container.scrollTop = top;
    if (top + rowHeight > container.scrollTop + viewportHeight) {
      container.scrollTop = top + rowHeight - viewportHeight;
    }
  };

  return (
    <div
      ref={containerRef}
      className="episode-virtual-rows"
      role="grid"
      aria-label={label}
      aria-rowcount={items.length}
      aria-activedescendant={items[activeIndex] ? `virtual-row-${getKey(items[activeIndex])}` : undefined}
      tabIndex={0}
      style={{ height: viewportHeight }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") move(activeIndex + 1);
        else if (event.key === "ArrowUp") move(activeIndex - 1);
        else if (event.key === "Home") move(0);
        else if (event.key === "End") move(items.length - 1);
        else if (event.key === "Enter" && items[activeIndex]) onSelect(items[activeIndex]);
        else return;
        event.preventDefault();
      }}
    >
      <div style={{ height: window.totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${window.offset}px)` }}>
          {items.slice(window.start, window.end).map((item, localIndex) => {
            const index = window.start + localIndex;
            const key = getKey(item);
            return (
              <div id={`virtual-row-${key}`} key={key} role="row" aria-rowindex={index + 1} aria-selected={key === selectedKey} className="episode-virtual-row" style={{ height: rowHeight }} onMouseDown={() => setActiveIndex(index)} onClick={() => onSelect(item)}>
                {renderRow(item, key === selectedKey)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
