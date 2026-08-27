package artifactpolicy

import (
	"errors"
	"math"
	"strings"
	"time"
)

const (
	SnapshotSchemaVersion         = "episode_config.v2"
	RecordingProfile              = "composite_720p_v1"
	MaximumSourceWindow           = 24 * time.Hour
	MaximumRetentionSeconds int64 = math.MaxInt64 / int64(time.Second)
)

var (
	ErrDefaultExceedsCeiling = errors.New("transcription default exceeds Tenant ceiling")
	ErrInvalidRetention      = errors.New("artifact retention is outside the supported range")
	ErrInvalidSourceWindow   = errors.New("transcription source window is outside the v1 boundary")
	ErrMissingProviderPolicy = errors.New("transcription provider policy version is required")
)

type TenantPolicy struct {
	TranscriptionCeiling      TranscriptionMode
	TranscriptionDefault      TranscriptionMode
	ProviderPolicyVersion     string
	RecordingRetention        time.Duration
	TranscriptRetention       time.Duration
	TranscriptionSourceWindow time.Duration
}

type SpacePolicy struct {
	Recording     RecordingMode
	Transcription TranscriptionMode
}

type RecordingSnapshot struct {
	Mode      RecordingMode
	Profile   string
	Retention time.Duration
}

type TranscriptionSnapshot struct {
	Mode                  TranscriptionMode
	ProviderPolicyVersion string
	Retention             time.Duration
	SourceWindow          time.Duration
}

type Snapshot struct {
	SchemaVersion string
	Recording     RecordingSnapshot
	Transcription TranscriptionSnapshot
}

func (policy TenantPolicy) Validate() error {
	if err := policy.TranscriptionCeiling.Validate(); err != nil {
		return err
	}
	if err := policy.TranscriptionDefault.Validate(); err != nil {
		return err
	}
	if policy.TranscriptionDefault.rank() > policy.TranscriptionCeiling.rank() {
		return ErrDefaultExceedsCeiling
	}
	maximumRetention := time.Duration(MaximumRetentionSeconds) * time.Second
	if policy.RecordingRetention < 0 ||
		policy.RecordingRetention > maximumRetention ||
		policy.TranscriptRetention < 0 ||
		policy.TranscriptRetention > maximumRetention {
		return ErrInvalidRetention
	}
	if policy.TranscriptionCeiling == TranscriptionDisabled {
		if policy.TranscriptionSourceWindow != 0 {
			return ErrInvalidSourceWindow
		}
		return nil
	}
	if policy.TranscriptionSourceWindow <= 0 || policy.TranscriptionSourceWindow > MaximumSourceWindow {
		return ErrInvalidSourceWindow
	}
	if strings.TrimSpace(policy.ProviderPolicyVersion) == "" {
		return ErrMissingProviderPolicy
	}
	return nil
}

func (policy SpacePolicy) Validate() error {
	if err := policy.Recording.Validate(); err != nil {
		return err
	}
	return policy.Transcription.Validate()
}

func SeedSpacePolicy(tenant TenantPolicy, recording RecordingMode) (SpacePolicy, error) {
	if err := tenant.Validate(); err != nil {
		return SpacePolicy{}, err
	}
	if err := recording.Validate(); err != nil {
		return SpacePolicy{}, err
	}
	return SpacePolicy{Recording: recording, Transcription: tenant.TranscriptionDefault}, nil
}

func Resolve(tenant TenantPolicy, space SpacePolicy) (Snapshot, error) {
	if err := tenant.Validate(); err != nil {
		return Snapshot{}, err
	}
	if err := space.Validate(); err != nil {
		return Snapshot{}, err
	}

	mode := transcriptionModeWithinCeiling(space.Transcription, tenant.TranscriptionCeiling)
	return Snapshot{
		SchemaVersion: SnapshotSchemaVersion,
		Recording: RecordingSnapshot{
			Mode:      space.Recording,
			Profile:   RecordingProfile,
			Retention: tenant.RecordingRetention,
		},
		Transcription: TranscriptionSnapshot{
			Mode:                  mode,
			ProviderPolicyVersion: tenant.ProviderPolicyVersion,
			Retention:             tenant.TranscriptRetention,
			SourceWindow:          tenant.TranscriptionSourceWindow,
		},
	}, nil
}
