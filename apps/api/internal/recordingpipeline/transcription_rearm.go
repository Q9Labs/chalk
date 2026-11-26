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
	for _, check := range transcriptionRearmRefusalChecks(candidate, now) {
		if check.condition {
			return check.refusal
		}
	}
	return ""
}

type transcriptionRearmRefusalCheck struct {
	condition bool
	refusal   string
}

func transcriptionRearmRefusalChecks(candidate TranscriptionRearmCandidate, now time.Time) []transcriptionRearmRefusalCheck {
	return []transcriptionRearmRefusalCheck{
		{transcriptionRearmAlreadySatisfied(candidate), "already_rearmed"},
		{candidate.State == JobStateSucceeded, "completed"},
		{transcriptionRearmNotExpired(candidate), "not_expired"},
		{transcriptionRearmModeDisabled(candidate), "transcription_disabled"},
		{!candidate.CaptureSucceeded, "capture_not_successful"},
		{transcriptionRearmOutputExists(candidate), "transcription_exists"},
		{transcriptionRearmRetentionExpired(candidate, now), "retention_expired"},
		{candidate.CleanupStarted, "cleanup_started"},
		{transcriptionRearmAlreadyClaimed(candidate), "already_claimed"},
		{transcriptionRearmSourceMissing(candidate), "missing_source"},
		{candidate.FailureHistoryCount >= 5, "retry_limit_reached"},
	}
}

func transcriptionRearmAlreadySatisfied(candidate TranscriptionRearmCandidate) bool {
	return candidate.HasRenewal && (candidate.State != JobStateTerminalFailure || candidate.ErrorCode != "recording_source_expired")
}

func transcriptionRearmNotExpired(candidate TranscriptionRearmCandidate) bool {
	return candidate.State != JobStateTerminalFailure || candidate.ErrorCode != "recording_source_expired"
}

func transcriptionRearmModeDisabled(candidate TranscriptionRearmCandidate) bool {
	return candidate.TranscriptionMode != "automatic" && candidate.TranscriptionMode != "on_demand"
}

func transcriptionRearmOutputExists(candidate TranscriptionRearmCandidate) bool {
	return candidate.HasTranscriptionSource || candidate.HasTranscript
}

func transcriptionRearmRetentionExpired(candidate TranscriptionRearmCandidate, now time.Time) bool {
	return candidate.CaptureRetentionExpiresAt == nil || !candidate.CaptureRetentionExpiresAt.After(now)
}

func transcriptionRearmAlreadyClaimed(candidate TranscriptionRearmCandidate) bool {
	return candidate.AttemptCount != 0 || candidate.HasAttemptAuthority
}

func transcriptionRearmSourceMissing(candidate TranscriptionRearmCandidate) bool {
	return candidate.BundleCount == 0 || !candidate.HasDataKey || !candidate.HasPresentation
}
