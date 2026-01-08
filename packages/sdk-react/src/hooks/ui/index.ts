/**
 * UI hooks namespace
 */

export { useLayout, type UseLayoutReturn } from "./useLayout";
export { usePanels, type UsePanelsReturn } from "./usePanels";
export { useNotifications, type UseNotificationsReturn } from "./useNotifications";

// Re-export useTour from utilities (it's both UI and utility)
export { useTour, type UseTourReturn, type TourStep } from "../useTour";
