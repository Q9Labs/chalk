// Package captureplane defines the provider-neutral signaling port for Chalk
// recorder workers.
//
// An adapter validates every input before crossing its provider boundary. It
// stores results by IdempotencyScope plus a canonical input payload: a retry
// with the same key and payload replays the result, while a changed payload
// returns IdempotencyConflictError. Capture epoch, plan revision, and
// negotiation identifiers are fencing authority. A stale operation returns a
// FencedError and does not touch provider state. Provider references remain
// opaque and must never be promoted to Chalk identity.
package captureplane
