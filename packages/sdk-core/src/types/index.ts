/**
 * Type exports for Chalk SDK
 *
 * Organized into three categories:
 * - `api/` - Types generated from OpenAPI specification
 * - `events/` - WebSocket event types (ServerEventMap, ClientEventMap)
 * - `entities/` - Domain entity types (Participant, ConferenceSession, etc.)
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/types
 */

// API types (generated from OpenAPI)
export * as api from './api';

// Event types
export * from './events';

// Entity types
export * from './entities';
