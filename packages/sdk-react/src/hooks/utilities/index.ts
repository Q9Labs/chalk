/**
 * Utilities hooks namespace
 */

// Re-export existing hooks from parent directory
export {
	useSoundEffects,
	type SoundEffect,
	type UseSoundEffectsOptions,
	type UseSoundEffectsReturn,
} from "../useSoundEffects";

export {
	useKeyboardShortcuts,
	createMeetingShortcuts,
	type KeyboardShortcut,
	type UseKeyboardShortcutsOptions,
	type UseKeyboardShortcutsReturn,
} from "../useKeyboardShortcuts";

export {
	useMediaQuery,
	useIsMobile,
	useIsTablet,
	useIsDesktop,
	usePrefersReducedMotion,
	usePrefersDarkMode,
} from "../useMediaQuery";

export {
	useAnnouncer,
	type AnnouncementPoliteness,
	type UseAnnouncerOptions,
	type UseAnnouncerReturn,
} from "../useAnnouncer";

export {
	useLogger,
	type UseLoggerReturn,
} from "./useLogger";
