// This file re-exports generated API types with friendlier names
// DO NOT EDIT MANUALLY - update openapi.yaml and run `bun run generate:types`

import type { components, operations, paths } from "./api-types";

// Re-export raw generated types
export type { components, operations, paths };

// Schema type aliases - Core entities
export type ApiRoom = components["schemas"]["Room"];
export type ApiParticipant = components["schemas"]["Participant"];
export type ApiRecording = components["schemas"]["Recording"];
export type ApiError = components["schemas"]["Error"];

// Schema type aliases - Extended types (available in api-types.ts)
export type ApiChatMessage = components["schemas"]["ChatMessage"];
export type ApiToken = components["schemas"]["Token"];

// Enum type aliases
export type ParticipantRole = ApiParticipant["role"];
export type RecordingStatus = ApiRecording["status"];
export type MessageType = ApiChatMessage["type"];

// Utility types
export type ApiSchemas = components["schemas"];
export type ApiResponses = components["responses"];
export type ApiParameters = components["parameters"];
