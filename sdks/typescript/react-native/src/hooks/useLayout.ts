import { useCallback, useEffect, useState } from "react";

import type { Layout } from "../ui/native-types";

export interface UseLayoutReturn {
  readonly layout: Layout;
  readonly isMobileView: boolean;
  readonly isFullscreen: boolean;
  readonly setLayout: (layout: Layout) => void;
  readonly toggleLayout: () => void;
  readonly toggleFullscreen: () => Promise<void>;
}

type UseLayoutOptions = {
  readonly layout?: Layout;
  readonly onLayoutChange?: (layout: Layout) => void;
};

export function useLayout({ layout: controlledLayout, onLayoutChange }: UseLayoutOptions = {}): UseLayoutReturn {
  const [uncontrolledLayout, setUncontrolledLayout] = useState<Layout>(controlledLayout ?? "focus");
  const [isFullscreen, setFullscreen] = useState(false);
  const layout = controlledLayout ?? uncontrolledLayout;
  useEffect(() => {
    if (controlledLayout) setUncontrolledLayout(controlledLayout);
  }, [controlledLayout]);
  const setLayout = useCallback(
    (nextLayout: Layout) => {
      if (!controlledLayout) setUncontrolledLayout(nextLayout);
      onLayoutChange?.(nextLayout);
    },
    [controlledLayout, onLayoutChange],
  );
  const toggleLayout = useCallback(() => setLayout(layout === "grid" ? "focus" : "grid"), [layout, setLayout]);
  const toggleFullscreen = useCallback(async () => setFullscreen((current) => !current), []);

  return { layout, isMobileView: true, isFullscreen, setLayout, toggleLayout, toggleFullscreen };
}
