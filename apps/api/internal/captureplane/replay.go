package captureplane

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
)

// ReplayCache lets an adapter answer an in-process retry with the result it
// already returned. It holds the newest entries up to its capacity. It does not
// survive a restart: the durable capturesignaling queue remains the source of
// truth for exact replay across restarts.
type ReplayCache struct {
	mu       sync.Mutex
	entries  map[string]replayEntry
	order    []string
	capacity int
}

type replayEntry struct {
	payloadDigest [32]byte
	result        any
}

func NewReplayCache(capacity int) *ReplayCache {
	return &ReplayCache{entries: make(map[string]replayEntry), capacity: capacity}
}

func replayIdentity(metadata OperationMetadata, operation OperationKind, input any) (string, [32]byte, error) {
	scope, err := metadata.IdempotencyScope(operation)
	if err != nil {
		return "", [32]byte{}, err
	}
	payload, err := json.Marshal(input)
	if err != nil {
		return "", [32]byte{}, ProviderError{Class: ProviderFailureProtocol, Code: "invalid_request", Retryable: false}
	}
	return hex.EncodeToString(scope[:]), sha256.Sum256(payload), nil
}

// ReplayLookup returns the stored result for the same key and payload. The same
// key with a changed payload is an IdempotencyConflictError.
func ReplayLookup[T any](cache *ReplayCache, metadata OperationMetadata, operation OperationKind, input any) (T, bool, error) {
	var zero T
	key, digest, err := replayIdentity(metadata, operation, input)
	if err != nil {
		return zero, false, err
	}
	if cache == nil {
		return zero, false, nil
	}
	cache.mu.Lock()
	entry, ok := cache.entries[key]
	cache.mu.Unlock()
	if !ok {
		return zero, false, nil
	}
	if entry.payloadDigest != digest {
		return zero, false, IdempotencyConflictError{Operation: operation}
	}
	result, ok := entry.result.(T)
	if !ok {
		return zero, false, ProviderError{Class: ProviderFailureProtocol, Code: "replay_type_mismatch", Retryable: false}
	}
	return result, true, nil
}

// ReplayStore remembers a result under the operation's idempotency key.
func ReplayStore[T any](cache *ReplayCache, metadata OperationMetadata, operation OperationKind, input any, result T) error {
	key, digest, err := replayIdentity(metadata, operation, input)
	if err != nil {
		return err
	}
	if cache == nil {
		return nil
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if _, exists := cache.entries[key]; !exists {
		if len(cache.order) >= cache.capacity {
			oldest := cache.order[0]
			delete(cache.entries, oldest)
			cache.order = cache.order[1:]
		}
		cache.order = append(cache.order, key)
	}
	cache.entries[key] = replayEntry{payloadDigest: digest, result: result}
	return nil
}
