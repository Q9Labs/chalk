package recordingpipeline

import (
	"errors"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrTranscriptionRearmUnavailable = errors.New("recording transcription re-arm unavailable")
	ErrTranscriptionRearmNotNeeded   = errors.New("recording transcription re-arm not needed")
)

type TranscriptionRearmInput struct {
	RecordingID utilities.ID
	Operator    string
	Reason      string
}

type TranscriptionRearmResult struct {
	JobID             utilities.ID
	FencingGeneration int64
	SourceExpiresAt   time.Time
}

type TranscriptionRearmCandidate struct {
	RecordingID               utilities.ID
	TenantID                  utilities.ID
	EpisodeID                 utilities.ID
	JobID                     utilities.ID
	State                     JobState
	ErrorCode                 string
	AttemptCount              int
	FencingGeneration         int64
	CaptureRetentionExpiresAt *time.Time
	CaptureSucceeded          bool
	TranscriptionMode         string
	HasTranscriptionSource    bool
	HasTranscript             bool
	HasDataKey                bool
	HasPresentation           bool
	BundleCount               int
	CleanupStarted            bool
	HasAttemptAuthority       bool
	FailureHistoryCount       int
	HasRenewal                bool
	ObjectKeys                []string
}

func ValidateTranscriptionRearmInput(input TranscriptionRearmInput) error {
	if input.RecordingID.IsZero() {
		return ErrInvalidRecordingID
	}
	if strings.TrimSpace(input.Operator) == "" || len(input.Operator) > 256 || strings.TrimSpace(input.Reason) == "" || len(input.Reason) > 1024 {
		return ErrTranscriptionRearmUnavailable
	}
	return nil
}

// TranscriptionRearmRefusal is the operator-facing eligibility decision. The
// database rechecks it under the re-arm locks before mutating the job.
func TranscriptionRearmRefusal(candidate TranscriptionRearmCandidate, now time.Time) string {
	if candidate.HasRenewal && (candidate.State != JobStateTerminalFailure || candidate.ErrorCode != "recording_source_expired") {
		return "already_rearmed"
	}
	if candidate.State == JobStateSucceeded {
		return "completed"
	}
	if candidate.State != JobStateTerminalFailure || candidate.ErrorCode != "recording_source_expired" {
		return "not_expired"
	}
	if candidate.TranscriptionMode != "automatic" && candidate.TranscriptionMode != "on_demand" {
		return "transcription_disabled"
	}
	if !candidate.CaptureSucceeded {
		return "capture_not_successful"
	}
	if candidate.HasTranscriptionSource || candidate.HasTranscript {
		return "transcription_exists"
	}
	if candidate.CaptureRetentionExpiresAt == nil || !candidate.CaptureRetentionExpiresAt.After(now) {
		return "retention_expired"
	}
	if candidate.CleanupStarted {
		return "cleanup_started"
	}
	if candidate.AttemptCount != 0 || candidate.HasAttemptAuthority {
		return "already_claimed"
	}
	if candidate.BundleCount == 0 || !candidate.HasDataKey || !candidate.HasPresentation {
		return "missing_source"
	}
	if candidate.FailureHistoryCount >= 5 {
		return "retry_limit_reached"
	}
	return ""
}
