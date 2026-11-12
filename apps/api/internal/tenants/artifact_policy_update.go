package tenants

import (
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// prepareArtifactPolicyUpdate normalizes the fields that are set and rejects the first invalid one.
func prepareArtifactPolicyUpdate(input *ArtifactPolicyUpdate) error {
	if input.TranscriptLanguage.Set && input.TranscriptLanguage.Value == nil {
		return ErrInvalidArtifactPolicy
	}
	if err := prepareTranscriptionMode(&input.TranscriptionCeiling); err != nil {
		return err
	}
	if err := prepareTranscriptionMode(&input.TranscriptionDefaultMode); err != nil {
		return err
	}
	if err := prepareProviderPolicyVersion(&input.ProviderPolicyVersion); err != nil {
		return err
	}
	if err := validateRetention(input.RecordingRetentionSeconds); err != nil {
		return err
	}
	if err := validateRetention(input.TranscriptRetentionSeconds); err != nil {
		return err
	}
	return validateSourceWindow(input.TranscriptionSourceWindowSeconds)
}

func prepareTranscriptionMode(field *utilities.OptionalString) error {
	if !field.Set {
		return nil
	}
	if field.Value == nil {
		return ErrInvalidArtifactPolicy
	}
	mode := artifactpolicy.TranscriptionMode(strings.TrimSpace(*field.Value))
	if err := mode.Validate(); err != nil {
		return err
	}
	value := string(mode)
	field.Value = &value
	return nil
}

func prepareProviderPolicyVersion(field *utilities.OptionalString) error {
	if !field.Set {
		return nil
	}
	if field.Value == nil {
		return artifactpolicy.ErrMissingProviderPolicy
	}
	value, err := utilities.RequiredString(*field.Value)
	if err != nil {
		return artifactpolicy.ErrMissingProviderPolicy
	}
	field.Value = &value
	return nil
}

func validateRetention(value OptionalInt64) error {
	if value.Set && (value.Value == nil || *value.Value < 0 || *value.Value > artifactpolicy.MaximumRetentionSeconds) {
		return artifactpolicy.ErrInvalidRetention
	}
	return nil
}

func validateSourceWindow(value OptionalInt64) error {
	maximum := int64(artifactpolicy.MaximumSourceWindow / time.Second)
	if value.Set && (value.Value == nil || *value.Value < 0 || *value.Value > maximum) {
		return artifactpolicy.ErrInvalidSourceWindow
	}
	return nil
}
