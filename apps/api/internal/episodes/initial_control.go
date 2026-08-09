package episodes

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"time"
)

const (
	controlStateDigestPrefix = "chalk-sync-state-v1"
	controlStateSchemaV1     = int32(1)
)

type InitialControlPolicy struct {
	ConfigSnapshot                json.RawMessage
	DeadlineAt                    time.Time
	DeadlineGeneration            int64
	AdmissionPolicy               json.RawMessage
	MaximumDurationSeconds        int32
	MaximumDurationCeilingSeconds int32
}

// NewInitialControlState validates immutable Episode policy and encodes the
// empty, pre-admission authority projection used by Sync.
func NewInitialControlState(policy InitialControlPolicy) (InitialControlState, error) {
	_, config, err := validateConfigSnapshot(policy.ConfigSnapshot)
	if err != nil {
		return InitialControlState{}, err
	}
	if len(policy.AdmissionPolicy) > 0 && string(canonicalJSON(policy.AdmissionPolicy)) != string(canonicalJSON(config.AdmissionPolicy)) {
		return InitialControlState{}, ErrInvalidAdmissionPolicy
	}
	if policy.MaximumDurationSeconds == 0 {
		policy.MaximumDurationSeconds = config.MaximumEpisodeDurationSeconds
	}
	if policy.MaximumDurationCeilingSeconds == 0 {
		policy.MaximumDurationCeilingSeconds = config.MaximumEpisodeDurationSeconds
	}
	if policy.MaximumDurationSeconds < MinimumEpisodeDurationSeconds || policy.MaximumDurationSeconds > MaximumEpisodeDurationSeconds {
		return InitialControlState{}, ErrInvalidMaximumDuration
	}
	if policy.MaximumDurationCeilingSeconds < MinimumEpisodeDurationSeconds || policy.MaximumDurationCeilingSeconds > MaximumEpisodeDurationSeconds || policy.MaximumDurationSeconds > policy.MaximumDurationCeilingSeconds {
		return InitialControlState{}, ErrInvalidMaximumDurationCeiling
	}
	if policy.DeadlineAt.IsZero() || policy.DeadlineAt.UnixMilli() < 1 || policy.DeadlineAt.UnixMilli() != policy.DeadlineAt.UTC().Truncate(time.Millisecond).UnixMilli() {
		return InitialControlState{}, ErrInvalidInitialControlState
	}
	if policy.DeadlineGeneration < 1 {
		return InitialControlState{}, ErrInvalidInitialControlState
	}
	admissionPolicy, err := admissionPolicyMode(config.AdmissionPolicy)
	if err != nil {
		return InitialControlState{}, err
	}

	durableProjection := map[string]any{
		"admission_policy":     admissionPolicy,
		"admission_requests":   []any{},
		"control_revision":     0,
		"deadline_at_ms":       policy.DeadlineAt.UTC().Truncate(time.Millisecond).UnixMilli(),
		"deadline_generation":  policy.DeadlineGeneration,
		"participants":         []any{},
		"recording":            nil,
		"role_capabilities":    config.Roles,
		"state_schema_version": controlStateSchemaV1,
		"status":               EpisodeStatusActive,
	}
	projection := canonicalJSON(mustJSON(durableProjection))

	digestInput := make([]byte, 0, len(controlStateDigestPrefix)+4+len(projection))
	digestInput = append(digestInput, controlStateDigestPrefix...)
	version := make([]byte, 4)
	binary.BigEndian.PutUint32(version, uint32(controlStateSchemaV1))
	digestInput = append(digestInput, version...)
	digestInput = append(digestInput, projection...)
	digest := sha256.Sum256(digestInput)

	durableProjection["state_digest"] = hex.EncodeToString(digest[:])
	wireSnapshot := canonicalJSON(mustJSON(durableProjection))
	return InitialControlState{FoldedState: projection, Digest: digest, SchemaVersion: controlStateSchemaV1, SnapshotBytes: int64(len(wireSnapshot))}, nil
}

func mustJSON(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
