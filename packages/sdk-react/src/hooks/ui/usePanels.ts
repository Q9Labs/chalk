"use client";

/**
 * usePanels - Panel control from UIManager
 */

import type { PanelType, UIState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UsePanelsReturn {
	/** Currently active panel */
	activePanel: PanelType;
	/** Whether controls are visible */
	controlsVisible: boolean;
	/** Open a specific panel */
	openPanel: (panel: PanelType) => void;
	/** Close current panel */
	closePanel: () => void;
	/** Toggle a panel */
	togglePanel: (panel: Exclude<PanelType, null>) => void;
	/** Show controls (with optional auto-hide) */
	showControls: (autoHideDelay?: number) => void;
	/** Hide controls */
	hideControls: () => void;
}

/**
 * Hook for panel control
 *
 * @example
 * ```tsx
 * function SidebarButtons() {
 *   const { activePanel, togglePanel } = usePanels();
 *
 *   return (
 *     <div>
 *       <button
 *         className={activePanel === 'chat' ? 'active' : ''}
 *         onClick={() => togglePanel('chat')}
 *       >
 *         Chat
 *       </button>
 *       <button
 *         className={activePanel === 'participants' ? 'active' : ''}
 *         onClick={() => togglePanel('participants')}
 *       >
 *         People
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function usePanels(): UsePanelsReturn {
	const session = useSession();
	const { ui } = session;

	const [state, setState] = useState<UIState>(() => ui.getState());

	useEffect(() => {
		return ui.subscribe(setState);
	}, [ui]);

	const openPanel = useCallback(
		(panel: PanelType): void => ui.openPanel(panel),
		[ui],
	);

	const closePanel = useCallback((): void => ui.closePanel(), [ui]);

	const togglePanel = useCallback(
		(panel: Exclude<PanelType, null>): void => ui.togglePanel(panel),
		[ui],
	);

	const showControls = useCallback(
		(autoHideDelay?: number): void => ui.showControls(autoHideDelay),
		[ui],
	);

	const hideControls = useCallback((): void => ui.hideControls(), [ui]);

	return useMemo(
		(): UsePanelsReturn => ({
			activePanel: state.activePanel,
			controlsVisible: state.controlsVisible,
			openPanel,
			closePanel,
			togglePanel,
			showControls,
			hideControls,
		}),
		[
			state,
			openPanel,
			closePanel,
			togglePanel,
			showControls,
			hideControls,
		],
	);
}
