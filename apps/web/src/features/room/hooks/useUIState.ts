/**
 * useUIState - UI state management hook
 *
 * Manages: panels, layout, tour visibility
 * Provides: UI state with action logging
 */

import { useCallback, useEffect, useState } from "react";
import { createDebugger } from "@/features/room/utils/debug";

const log = createDebugger("useUIState");

type PanelType = "chat" | "info" | "participants" | null;
type LayoutType = "grid" | "spotlight";

export interface UIState {
	// Panels
	activePanel: PanelType;
	setActivePanel: (panel: PanelType) => void;
	togglePanel: (panel: Exclude<PanelType, null>) => void;

	// Layout
	layout: LayoutType;
	toggleLayout: () => void;

	// Tour
	showTour: boolean;
	setShowTour: (show: boolean) => void;
	handleTourComplete: () => void;
}

export function useUIState(): UIState {
	// Panel State
	const [activePanel, setActivePanelInternal] = useState<PanelType>(null);

	// Layout State
	const [layout, setLayout] = useState<LayoutType>("grid");

	// Tour State - hydrate after mount to prevent SSR mismatch
	const [showTour, setShowTourInternal] = useState(false);

	// ==========================================================================
	// LIFECYCLE
	// ==========================================================================

	useEffect(() => {
		log.lifecycle("mount");

		// Hydrate tour state from localStorage after mount
		const isCompleted =
			typeof window !== "undefined" &&
			localStorage.getItem("chalk_tour_completed");

		const shouldShowTour = !isCompleted;
		log.debug("Tour Hydration", {
			tourCompleted: !!isCompleted,
			shouldShowTour,
		});

		setShowTourInternal(shouldShowTour);

		return () => {
			log.lifecycle("unmount");
		};
	}, []);

	// ==========================================================================
	// PANEL ACTIONS
	// ==========================================================================

	const setActivePanel = useCallback((panel: PanelType) => {
		log.action("toggle", "Set active panel", panel || "none");
		log.stateChange("activePanel", activePanel, panel);
		setActivePanelInternal(panel);
	}, [activePanel]);

	const togglePanel = useCallback((panel: Exclude<PanelType, null>) => {
		setActivePanelInternal((current) => {
			const newPanel = current === panel ? null : panel;
			log.action("toggle", `Toggle panel: ${panel}`, newPanel ? "open" : "closed");
			log.debug("Panel Toggle", {
				panel,
				wasOpen: current === panel,
				isNowOpen: newPanel === panel,
			});
			return newPanel;
		});
	}, []);

	// ==========================================================================
	// LAYOUT ACTIONS
	// ==========================================================================

	const toggleLayout = useCallback(() => {
		setLayout((current) => {
			const newLayout = current === "grid" ? "spotlight" : "grid";
			log.action("toggle", "Toggle layout", newLayout);
			log.stateChange("layout", current, newLayout);
			return newLayout;
		});
	}, []);

	// ==========================================================================
	// TOUR ACTIONS
	// ==========================================================================

	const setShowTour = useCallback((show: boolean) => {
		log.action("toggle", "Set tour visibility", show ? "show" : "hide");
		setShowTourInternal(show);
	}, []);

	const handleTourComplete = useCallback(() => {
		log.action("click", "Tour completed/skipped");

		if (typeof window !== "undefined") {
			localStorage.setItem("chalk_tour_completed", "true");
			log.info("success", "Tour completion saved to localStorage", "state");
		}

		setShowTourInternal(false);
	}, []);

	// ==========================================================================
	// DEBUG: Log state changes
	// ==========================================================================

	useEffect(() => {
		log.debug("UI State Summary", {
			activePanel,
			layout,
			showTour,
		});
	}, [activePanel, layout, showTour]);

	return {
		// Panels
		activePanel,
		setActivePanel,
		togglePanel,

		// Layout
		layout,
		toggleLayout,

		// Tour
		showTour,
		setShowTour,
		handleTourComplete,
	};
}
