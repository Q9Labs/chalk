import { useEffect, useRef } from "react";

import type { StageLayout } from "../stage/stage-items";

/**
 * Brings content (a screen share or the whiteboard) forward the moment it appears by switching to
 * the presentation layout, and restores the previous layout when the last content item goes away.
 * The switch happens once per appearance, so people can still pick another layout while content is up.
 */
export function useContentLayoutSwitch(hasContent: boolean, layout: StageLayout, updateLayout: (layout: StageLayout) => void): void {
  const memoryRef = useRef<{ hasContent: boolean; layoutBefore: StageLayout | null }>({ hasContent: false, layoutBefore: null });

  useEffect(() => {
    const memory = memoryRef.current;
    if (hasContent === memory.hasContent) return;
    if (hasContent) {
      memoryRef.current = { hasContent: true, layoutBefore: layout };
      if (layout !== "presentation") updateLayout("presentation");
      return;
    }
    memoryRef.current = { hasContent: false, layoutBefore: null };
    if (layout === "presentation" && memory.layoutBefore && memory.layoutBefore !== "presentation") updateLayout(memory.layoutBefore);
  }, [hasContent, layout, updateLayout]);
}
