package transcripts

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	maxTranscriptionChunks       = 4096
	maxArtifactJobKeyLength      = 128
	maxRequestIdempotencyKeySize = maxArtifactJobKeyLength - len("-4095")
)

func prepareRequestInput(input *RequestInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.RecordingID.IsZero() {
		return ErrInvalidRecordingID
	}
	key, err := utilities.RequiredString(input.IdempotencyKey)
	if err != nil || len(key) > maxRequestIdempotencyKeySize || strings.ContainsFunc(key, isInvalidIdempotencyKeyChar) {
		return ErrInvalidIdempotencyKey
	}
	input.IdempotencyKey = key
	// Queue priority and retry budget are release policy, never tenant input.
	input.Priority = 0
	input.AttemptLimit = 4
	if err := prepareRequestLanguages(input); err != nil {
		return err
	}
	if len(input.Traceparent) > 256 || len(input.Tracestate) > 512 {
		return ErrInvalidTranscriptField
	}
	if input.Now.IsZero() {
		input.Now = time.Now()
	}
	return nil
}

func isInvalidIdempotencyKeyChar(char rune) bool {
	return !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '.' || char == '_' || char == '-')
}

func prepareRequestLanguages(input *RequestInput) error {
	if input.Language != "" {
		if err := validateSingleRequestLanguage(input); err != nil {
			return err
		}
	}
	if len(input.Languages) == 0 && input.Language != "" {
		input.Languages = []string{input.Language}
	}
	if len(input.Languages) > 16 {
		return ErrInvalidLanguages
	}
	for i := range input.Languages {
		language, err := utilities.RequiredString(input.Languages[i])
		if err != nil || len(language) > 32 {
			return ErrInvalidLanguages
		}
		if _, err := artifactpolicy.ParseTranscriptLanguage(language); err != nil {
			return ErrInvalidLanguages
		}
		input.Languages[i] = language
	}
	return nil
}

func validateSingleRequestLanguage(input *RequestInput) error {
	if _, err := artifactpolicy.ParseTranscriptLanguage(input.Language); err != nil {
		return ErrInvalidLanguages
	}
	if len(input.Language) > 32 {
		return ErrInvalidTranscriptField
	}
	if len(input.Languages) > 0 && (len(input.Languages) != 1 || input.Languages[0] != input.Language) {
		return ErrInvalidLanguages
	}
	return nil
}

func prepareClaimInput(input *ClaimInput) error {
	if input.Owner == "" || len(input.Owner) > 128 {
		return ErrInvalidLease
	}
	if input.LeaseDuration <= 0 || input.LeaseDuration > 15*time.Minute {
		return ErrInvalidLease
	}
	if input.Now.IsZero() {
		input.Now = time.Now()
	}
	return nil
}

func prepareLeaseInput(input *LeaseInput) error {
	if input.JobID.IsZero() || input.Attempt < 1 || input.Attempt > 32 || input.LeaseOwner == "" || len(input.LeaseOwner) > 128 || input.LeaseToken == "" || len(input.LeaseToken) > 256 {
		return ErrInvalidLease
	}
	if input.Now.IsZero() {
		input.Now = time.Now()
	}
	return nil
}

func prepareResultInput(input *ResultInput) error {
	lease := LeaseInput{JobID: input.JobID, Attempt: input.Attempt, LeaseOwner: input.LeaseOwner, LeaseToken: input.LeaseToken, Now: input.Now}
	if err := prepareLeaseInput(&lease); err != nil {
		return err
	}
	if !input.ChunkID.IsZero() && input.Generation < 1 {
		return ErrInvalidArtifact
	}
	if !validResultObject(input) || !validResultProvider(input) || !validResultDurations(input) {
		return ErrInvalidArtifact
	}
	if len(input.ExecutionIdentity) > 256 || len(input.ProviderRequestID) > 256 {
		return ErrInvalidArtifact
	}
	if len(input.Quality) == 0 {
		input.Quality = json.RawMessage(`{}`)
	}
	if !json.Valid(input.Quality) || len(input.Quality) > 16384 {
		return ErrInvalidArtifact
	}
	return nil
}

func validResultObject(input *ResultInput) bool {
	return len(input.ResultSHA256) == 32 && input.ResultSize >= 1 && input.ResultSize <= 524288000 && input.ResultContentType == "application/json"
}

func validResultProvider(input *ResultInput) bool {
	return inRange(len(input.Provider), 1, 128) && inRange(len(input.Model), 1, 256) && inRange(len(input.ProviderVersion), 1, 256)
}

func validResultDurations(input *ResultInput) bool {
	if !inRange(input.BilledAudioSeconds, 0, 86400) || !inRange(input.MeasuredAudioMS, 0, 86400000) {
		return false
	}
	if input.ProviderDurationSeconds != nil && !inRange(*input.ProviderDurationSeconds, 0, 86400) {
		return false
	}
	return input.ProviderObservedDurationMS == nil || inRange(*input.ProviderObservedDurationMS, 0, 86400000)
}

func inRange[T int | int64](value, low, high T) bool {
	return value >= low && value <= high
}

func validateBoundedKey(value string) error {
	if value == "" || len(value) > 1024 || value[0] == '/' || bytes.Contains([]byte(value), []byte("//")) {
		return ErrInvalidArtifact
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return ErrInvalidArtifact
		}
	}
	return nil
}
