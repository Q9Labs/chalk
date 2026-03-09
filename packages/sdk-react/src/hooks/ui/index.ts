/**
 * UI hooks namespace
 */

export { useLayout, type UseLayoutReturn } from "./useLayout";
export { usePanels, type UsePanelsReturn } from "./usePanels";
export { useNotifications, type UseNotificationsReturn } from "./useNotifications";
export { useWhatsNew, type UseWhatsNewReturn, type UseWhatsNewOptions, type WhatsNewData } from "./useWhatsNew";
export { useParticipantVolume, type UseParticipantVolumeReturn } from "./useParticipantVolume";
export { useDraggable, type UseDraggableOptions } from "./useDraggable";
export { useHaptics, type UseHapticsOptions, type UseHapticsReturn, type ChalkHapticInput, type ChalkHapticPreset, type ChalkHapticTriggerOptions } from "./useHaptics";
export { usePictureInPicture, type UsePictureInPictureOptions, type UsePictureInPictureReturn } from "./usePictureInPicture";

// Re-export useTour from utilities (it's both UI and utility)
export { useTour, type UseTourReturn, type TourStep } from "../useTour";
