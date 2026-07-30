import { useCallback, useState } from "react";

import type { NativePanel } from "../ui/native-types";

export interface UsePanelsReturn {
  readonly activePanel: NativePanel;
  readonly controlsVisible: boolean;
  readonly openPanel: (panel: NativePanel) => void;
  readonly closePanel: () => void;
  readonly togglePanel: (panel: Exclude<NativePanel, null>) => void;
  readonly showControls: () => void;
  readonly hideControls: () => void;
}

export function usePanels(): UsePanelsReturn {
  const [activePanel, setActivePanel] = useState<NativePanel>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const closePanel = useCallback(() => setActivePanel(null), []);
  const togglePanel = useCallback((panel: Exclude<NativePanel, null>) => setActivePanel((current) => (current === panel ? null : panel)), []);

  return {
    activePanel,
    controlsVisible,
    openPanel: setActivePanel,
    closePanel,
    togglePanel,
    showControls: () => setControlsVisible(true),
    hideControls: () => setControlsVisible(false),
  };
}
