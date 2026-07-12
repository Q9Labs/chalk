import type { LayoutMode, UIState } from "../internal/core";
import { useCallback, useMemo } from "react";
import { useSession } from "../context/chalk-native-provider";
import { useManagerState } from "./external-store";

export interface UseLayoutReturn {
  layout: LayoutMode;
  isMobileView: boolean;
  isFullscreen: boolean;
  setLayout: (layout: LayoutMode) => void;
  toggleLayout: () => void;
  toggleFullscreen: () => Promise<void>;
}

export function useLayout(): UseLayoutReturn {
  const session = useSession();
  const { ui } = session;
  const state = useManagerState<UIState>(ui);

  const setLayout = useCallback((layout: LayoutMode) => ui.setLayout(layout), [ui]);
  const toggleLayout = useCallback(() => ui.toggleLayout(), [ui]);
  const toggleFullscreen = useCallback(() => ui.toggleFullscreen(), [ui]);

  return useMemo(
    () => ({
      layout: state.layout,
      isMobileView: state.isMobileView,
      isFullscreen: state.isFullscreen,
      setLayout,
      toggleLayout,
      toggleFullscreen,
    }),
    [state, setLayout, toggleLayout, toggleFullscreen],
  );
}
