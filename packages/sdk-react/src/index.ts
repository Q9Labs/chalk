/**
 * @q9labs/chalk-react - React SDK for Chalk video conferencing
 *
 * @packageDocumentation
 * @module @q9labs/chalk-react
 */

// Re-export useful types from core
export type {
	ChalkError,
	ChatMessage,
	MediaDevice,
	Participant,
	Reaction,
	ReactionEmoji,
	Recording,
	Room,
	RoomConfig,
	RoomInfo,
	RoomStatus,
	ScreenShareOptions,
} from "@q9labs/chalk-core";
// Re-export error codes
export { ChalkErrorCode } from "@q9labs/chalk-core";

// Context
export * from './context';

// Hooks
export * from './hooks';

// Components
export * from './components';

// Utils
export * from './utils';

// Styles - export path for consumers to import
export const CHALK_STYLES_PATH = '@q9labs/chalk-react/dist/styles/base.css';
