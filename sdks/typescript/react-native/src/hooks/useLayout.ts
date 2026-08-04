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

export function useLayout(initialLayout?: Layout, controlledLayout?: Layout): UseLayoutReturn {
  const [layout, setLayout] = useState<Layout>(initialLayout ?? "grid");
  const [isFullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (controlledLayout !== undefined) setLayout(controlledLayout);
  }, [controlledLayout]);
  const toggleLayout = useCallback(() => setLayout((current) => (current === "grid" ? "focus" : "grid")), []);
  const toggleFullscreen = useCallback(async () => setFullscreen((current) => !current), []);

  return { layout, isMobileView: true, isFullscreen, setLayout, toggleLayout, toggleFullscreen };
}
