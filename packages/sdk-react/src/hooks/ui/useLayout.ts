"use client";

/**
 * useLayout - Layout control from UIManager
 */

import type { LayoutMode, UIState } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseLayoutReturn {
	/** Current layout mode */
	layout: LayoutMode;
	/** Whether in mobile view */
	isMobileView: boolean;
	/** Whether fullscreen is active */
	isFullscreen: boolean;
	/** Set layout mode */
	setLayout: (layout: LayoutMode) => void;
	/** Toggle between grid and spotlight */
	toggleLayout: () => void;
	/** Toggle fullscreen mode */
	toggleFullscreen: () => Promise<void>;
}

/**
 * Hook for layout control
 *
 * @example
 * ```tsx
 * function LayoutSwitcher() {
 *   const { layout, setLayout, isMobileView } = useLayout();
 *
 *   if (isMobileView) {
 *     return null; // Hide on mobile
 *   }
 *
 *   return (
 *     <div>
 *       <button
 *         className={layout === 'grid' ? 'active' : ''}
 *         onClick={() => setLayout('grid')}
 *       >
 *         Grid
 *       </button>
 *       <button
 *         className={layout === 'spotlight' ? 'active' : ''}
 *         onClick={() => setLayout('spotlight')}
 *       >
 *         Spotlight
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useLayout(): UseLayoutReturn {
	const session = useSession();
	const { ui } = session;

	const [state, setState] = useState<UIState>(() => ui.getState());

	useEffect(() => {
		return ui.subscribe(setState);
	}, [ui]);

	const setLayout = useCallback(
		(layout: LayoutMode): void => ui.setLayout(layout),
		[ui],
	);

	const toggleLayout = useCallback((): void => ui.toggleLayout(), [ui]);

	const toggleFullscreen = useCallback(
		(): Promise<void> => ui.toggleFullscreen(),
		[ui],
	);

	return useMemo(
		(): UseLayoutReturn => ({
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
