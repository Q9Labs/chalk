package sessionlifecycle

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"time"
)

const (
	controlStateDigestPrefix = "chalk-sync-state-v3"
	controlStateSchemaV3     = int32(3)
)

type InitialControlPolicy struct {
	AdmissionPolicy               string
	HostExitPolicy                string
	RoleCapabilities              map[string][]string
	MaximumDurationSeconds        int32
	MaximumDurationCeilingSeconds int32
	DeadlineAt                    time.Time
}

// NewInitialControlState validates immutable Session policy and encodes the
// empty, pre-admission v3 authority projection.
func NewInitialControlState(policy InitialControlPolicy) (InitialControlState, error) {
	policy, err := validateInitialControlPolicy(policy)
	if err != nil {
		return InitialControlState{}, err
	}

	durableProjection := map[string]any{
		"admission_policy":            policy.AdmissionPolicy,
		"admission_requests":          []any{},
		"control_revision":            0,
		"deadline_at_ms":              policy.DeadlineAt.UnixMilli(),
		"deadline_generation":         1,
		"host_exit_policy":            policy.HostExitPolicy,
		"host_participant_session_id": nil,
		"participants":                []any{},
		"recording":                   nil,
		"role_capabilities":           policy.RoleCapabilities,
		"state_schema_version":        controlStateSchemaV3,
		"status":                      SessionStatusActive,
	}
	projection, _ := json.Marshal(durableProjection)
	projection = canonicalJSON(projection)

	digestInput := make([]byte, 0, len(controlStateDigestPrefix)+4+len(projection))
	digestInput = append(digestInput, controlStateDigestPrefix...)
	version := make([]byte, 4)
	binary.BigEndian.PutUint32(version, uint32(controlStateSchemaV3))
	digestInput = append(digestInput, version...)
	digestInput = append(digestInput, projection...)
	digest := sha256.Sum256(digestInput)

	durableProjection["state_digest"] = hex.EncodeToString(digest[:])
	wireSnapshot := canonicalJSON(mustJSON(durableProjection))

	return InitialControlState{
		FoldedState:   projection,
		Digest:        digest,
		SchemaVersion: controlStateSchemaV3,
		SnapshotBytes: int64(len(wireSnapshot)),
	}, nil
}

func mustJSON(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
