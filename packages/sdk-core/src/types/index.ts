/**
 * Type exports for Chalk SDK
 *
 * Organized into three categories:
 * - `api/` - Legacy API contract compatibility namespace
 * - `events/` - WebSocket event types (ServerEventMap, ClientEventMap)
 * - `entities/` - Domain entity types (Participant, ConferenceSession, etc.)
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

// Legacy API contract compatibility namespace.
export * as api from "./api";

// Event types
export * from "./events";

// Entity types
export * from "./entities";
