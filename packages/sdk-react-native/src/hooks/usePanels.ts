import type { PanelType, UIState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

export interface UsePanelsReturn {
  activePanel: PanelType;
  controlsVisible: boolean;
  openPanel: (panel: PanelType) => void;
  closePanel: () => void;
  togglePanel: (panel: Exclude<PanelType, null>) => void;
  showControls: (autoHideDelay?: number) => void;
  hideControls: () => void;
}

export function usePanels(): UsePanelsReturn {
  const session = useSession();
  const { ui } = session;
  const [state, setState] = useState<UIState>(() => ui.getState());

  useEffect(() => ui.subscribe(setState), [ui]);

  const openPanel = useCallback((panel: PanelType) => ui.openPanel(panel), [ui]);
  const closePanel = useCallback(() => ui.closePanel(), [ui]);
  const togglePanel = useCallback((panel: Exclude<PanelType, null>) => ui.togglePanel(panel), [ui]);
  const showControls = useCallback((autoHideDelay?: number) => ui.showControls(autoHideDelay), [ui]);
  const hideControls = useCallback(() => ui.hideControls(), [ui]);

  return useMemo(
    () => ({
      activePanel: state.activePanel,
      controlsVisible: state.controlsVisible,
      openPanel,
      closePanel,
      togglePanel,
      showControls,
      hideControls,
    }),
    [state, openPanel, closePanel, togglePanel, showControls, hideControls],
  );
}
