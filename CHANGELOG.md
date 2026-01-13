# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

#### Tests
- Updated 12 handler tests to align with security fix behavior (auth checks, token types, CORS)
- Fixed handler order: JSON parsing before auth for proper 400 vs 403 responses

#### API - Critical
- Tenant ownership bypass: API endpoints now verify path ID matches authenticated tenant (API-CRIT-01)
- Cross-tenant access: Room/participant/recording handlers scope queries by JWT claims (API-CRIT-02)

#### API - High
- JWT hardcoded secret: Config now loaded from env; production fails fast on dev secrets (API-HIGH-01)
- Token type validation: `ValidateToken` enforces `TokenType == "access"` (API-HIGH-02)
- WebSocket CSWSH: Origin checking enabled; query param token deprecated (API-HIGH-03)
- Permission authorization: Host role required for grant/revoke operations (API-HIGH-04)
- Recording permissions: `RequireHost()` middleware added to start/stop/archive (API-HIGH-05)
- Recording status constraint: Migration adds 'failed' status (API-HIGH-06)
- Webhook body consumption: Body reset after signature verification (API-HIGH-07)
- Participant nil dereference: `GetParticipant` error now checked (API-HIGH-08)

#### API - Medium
- O(n) API key lookup: Paginated search replaces hard 1000 limit (API-MED-01)
- Demo tenant creation: Uses known name instead of arbitrary first tenant (API-MED-02)
- DB port config: Now parsed from environment instead of hardcoded 5432 (API-MED-03)
- S3/R2 error detection: Uses `errors.As` for proper NotFound handling (API-MED-05)
- CORS credentials: Only set when origin is allowed; added `Vary: Origin` (API-MED-06)
- Health endpoint: No longer exposes internal DB error details (API-MED-07)
- Cloudflare mocks: All client methods now have demo mode fallbacks (API-MED-08)
- Redis TTLs: Participant state uses pipeline with TTL on add (API-MED-09)
- Redis nil handling: `GetRecordingState` treats nil as "no recording" (API-MED-10)

#### SDK-Core - High
- Token fallback: Removed `authToken` fallback; throws `AUTH_FAILED` if missing (SDKCORE-HIGH-01)

#### SDK-Core - Medium
- Empty response handling: 204/empty responses handled before JSON parse (SDKCORE-MED-01)
- Refresh serialization: Concurrent refresh requests now share a single promise (SDKCORE-MED-02)
- Node.js compatibility: `isTokenExpired` uses `Buffer.from` fallback (SDKCORE-MED-03)
- Memory leak: Resize handler stored for proper cleanup (SDKCORE-MED-06)
- Toggle locks: Separate locks for audio/video operations (SDKCORE-MED-07)

#### SDK-Core - Low
- Heartbeat timeout: 2.5x interval without pong triggers reconnect (SDKCORE-LOW-01)

### Added
- Migration `005_add_failed_recording_status.sql` for recording status constraint
- Effect-TS foundation for SDK-Core internal async/state/validation patterns:
  - `src/effect/errors.ts`: Tagged error types with exhaustive matching
  - `src/effect/services.ts`: Context Tags for dependency injection (TokenService, LoggerService, etc.)
  - `src/effect/runtime.ts`: Bridge between Effect internals and Promise-based public API
  - `src/effect/token-service.ts`: Token management with exponential backoff retry
  - `src/effect/connection.ts`: Scoped resources with acquireRelease for RTK/WebSocket
  - `src/effect/websocket.ts`: Reconnect schedules, heartbeat fibers, message queues
  - `src/effect/schemas/ws-events.ts`: Runtime validation schemas for WS payloads
  - `src/effect/schemas/api.ts`: Runtime validation schemas for API responses

### Changed
- `client.ts`: Integrated Effect patterns into `joinRoom`:
  - Replaced `isJoining` boolean with `OperationLock` for serialized joins
  - Added `_initRealtimeKitEffect` for RTK init with typed `ConnectionError`
  - Added `_joinRealtimeKitEffect` for RTK join with `Effect.timeout` handling
  - Public API unchanged (still returns `Promise<Room>`)
