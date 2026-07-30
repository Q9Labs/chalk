import { useCallback, useState } from "react";

import type { NativeLayout } from "../ui/native-types";

export interface UseLayoutReturn {
  readonly layout: NativeLayout;
  readonly isMobileView: boolean;
  readonly isFullscreen: boolean;
  readonly setLayout: (layout: NativeLayout) => void;
  readonly toggleLayout: () => void;
  readonly toggleFullscreen: () => Promise<void>;
}

export function useLayout(): UseLayoutReturn {
  const [layout, setLayout] = useState<NativeLayout>("grid");
  const [isFullscreen, setFullscreen] = useState(false);
  const toggleLayout = useCallback(() => setLayout((current) => (current === "grid" ? "speaker" : "grid")), []);
  const toggleFullscreen = useCallback(async () => setFullscreen((current) => !current), []);

  return { layout, isMobileView: true, isFullscreen, setLayout, toggleLayout, toggleFullscreen };
}
