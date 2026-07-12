package transcripts

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func prepareRequestInput(input *RequestInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.RecordingID.IsZero() {
		return ErrInvalidRecordingID
	}
	key, err := utilities.RequiredString(input.IdempotencyKey)
	if err != nil || len(key) > 128 {
		return ErrInvalidIdempotencyKey
	}
	for _, char := range key {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '.' || char == '_' || char == '-') {
			return ErrInvalidIdempotencyKey
		}
	}
	input.IdempotencyKey = key
	if err := validateBoundedKey(input.ManifestKey); err != nil {
		return ErrInvalidManifest
	}
	if len(input.ManifestSHA256) != 32 || input.ManifestSize < 1 || input.ManifestSize > 524288000 {
		return ErrInvalidManifest
	}
	if input.ManifestContentType != "application/json" {
		return ErrInvalidManifest
	}
	if len(input.Chunks) == 0 || len(input.Chunks) > 4096 {
		return ErrInvalidChunk
	}
	// Queue priority and retry budget are release policy, never tenant input.
	input.Priority = 0
	input.AttemptLimit = 4
	for i := range input.Chunks {
		chunk := &input.Chunks[i]
		if chunk.ID.IsZero() {
			id, err := utilities.NewID()
			if err != nil {
				return err
			}
			chunk.ID = id
		}
		if chunk.Index != i || chunk.Generation < 1 || chunk.StartMS < 0 || chunk.EndMS <= chunk.StartMS || chunk.EndMS-chunk.StartMS > 15*60*1000 {
			return ErrInvalidChunk
		}
		if err := validateBoundedKey(chunk.StorageKey); err != nil || len(chunk.Checksum) != 32 || chunk.Size < 1 || chunk.Size > 524288000 {
			return ErrInvalidChunk
		}
		if err := validateContentType(chunk.ContentType); err != nil {
			return ErrInvalidChunk
		}
		if len(chunk.ParticipantRef) > 128 || len(chunk.TrackEpoch) > 128 {
			return ErrInvalidChunk
		}
		if chunk.IdentityKind == "" {
			chunk.IdentityKind = "unknown"
		}
		if chunk.TrackClass == "" {
			chunk.TrackClass = "unknown"
		}
		if chunk.IdentityKind != "participant" && chunk.IdentityKind != "shared" && chunk.IdentityKind != "unknown" {
			return ErrInvalidChunk
		}
		if chunk.TrackClass != "microphone" && chunk.TrackClass != "screen-share" && chunk.TrackClass != "system-audio" && chunk.TrackClass != "unknown" {
			return ErrInvalidChunk
		}
		if chunk.IdentityKind == "participant" && (chunk.ParticipantRef == "" || chunk.TrackEpoch == "") {
			return ErrInvalidChunk
		}
		if chunk.IdentityKind != "participant" && (chunk.ParticipantRef != "" || chunk.TrackEpoch != "") {
			return ErrInvalidChunk
		}
		if chunk.TrackClass == "system-audio" && chunk.IdentityKind == "participant" {
			return ErrInvalidChunk
		}
	}
	if input.Language != "" && len(input.Language) > 32 {
		return ErrInvalidTranscriptField
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
		input.Languages[i] = language
	}
	if len(input.Traceparent) > 256 || len(input.Tracestate) > 512 {
		return ErrInvalidTranscriptField
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
	if len(input.ResultSHA256) != 32 || input.ResultSize < 1 || input.ResultSize > 524288000 {
		return ErrInvalidArtifact
	}
	if input.ResultContentType != "application/json" {
		return ErrInvalidArtifact
	}
	if len(input.Provider) == 0 || len(input.Provider) > 128 || len(input.Model) == 0 || len(input.Model) > 256 || len(input.ProviderVersion) == 0 || len(input.ProviderVersion) > 256 {
		return ErrInvalidArtifact
	}
	if input.BilledAudioSeconds < 0 || input.BilledAudioSeconds > 86400 {
		return ErrInvalidArtifact
	}
	if input.ProviderDurationSeconds != nil && (*input.ProviderDurationSeconds < 0 || *input.ProviderDurationSeconds > 86400) {
		return ErrInvalidArtifact
	}
	if input.MeasuredAudioMS < 0 || input.MeasuredAudioMS > 86400000 || (input.ProviderObservedDurationMS != nil && (*input.ProviderObservedDurationMS < 0 || *input.ProviderObservedDurationMS > 86400000)) {
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

func validateContentType(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || !strings.Contains(value, "/") {
		return ErrInvalidArtifact
	}
	return nil
}
