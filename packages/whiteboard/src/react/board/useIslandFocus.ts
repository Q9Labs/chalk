import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";

/** The phone launcher unmounts when it opens the tools, so keyboard focus moves to the first tool instead of falling to the page. */
export function useExpandedTools(island: RefObject<HTMLElement | null>) {
  const [expanded, setExpanded] = useState(false);
  const focusOnExpand = useRef(false);

  useLayoutEffect(() => {
    if (!expanded || !focusOnExpand.current) return;
    focusOnExpand.current = false;
    island.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [expanded, island]);

  const openFromLauncher = (event: MouseEvent<HTMLButtonElement>) => {
    focusOnExpand.current = event.currentTarget === document.activeElement;
    setExpanded(true);
  };
  return { expanded, openFromLauncher };
}

/** One button of the island is the tab stop and the rest are reached with the arrow keys; the stop stays on the same button while it is enabled. */
export function useRovingTabStop(island: RefObject<HTMLElement | null>) {
  const tabStop = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const buttons = [...(island.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const stop = buttons.find((button) => button === tabStop.current && !button.disabled) ?? buttons.find((button) => !button.disabled);
    tabStop.current = stop ?? null;
    for (const button of buttons) button.tabIndex = button === stop ? 0 : -1;
  });
  return tabStop;
}
