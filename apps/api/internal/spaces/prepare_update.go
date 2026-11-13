package spaces

import (
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func prepareUpdateSpaceInput(input *UpdateSpaceInput) error {
	if err := prepareUpdateIdentity(input); err != nil {
		return err
	}
	if err := prepareUpdateDocuments(input); err != nil {
		return err
	}
	if err := prepareUpdatePolicies(input); err != nil {
		return err
	}
	if err := prepareUpdateDurations(input); err != nil {
		return err
	}
	return validateOptionalLingerWindow(input.LingerWindowSeconds)
}

func prepareUpdateIdentity(input *UpdateSpaceInput) error {
	if input.Name.Set && input.Name.Value != nil && utf8.RuneCountInString(*input.Name.Value) > MaxNameCodePoints {
		return ErrInvalidSpaceName
	}
	var err error
	if input.Name, err = requiredOptionalString(input.Name, ErrInvalidSpaceName); err != nil {
		return err
	}
	if input.Slug, err = requiredOptionalString(input.Slug, ErrInvalidSpaceSlug); err != nil {
		return err
	}
	if input.MediaPlane.Set && input.MediaPlane.Value != nil {
		provider, parseErr := ParseMediaPlaneProvider(*input.MediaPlane.Value)
		if parseErr != nil {
			return ErrInvalidMediaPlane
		}
		value := string(provider)
		input.MediaPlane.Value = &value
	}
	return nil
}

func prepareUpdateDocuments(input *UpdateSpaceInput) error {
	var err error
	if input.Metadata, err = utilities.OptionalNullableJSON(input.Metadata); err != nil {
		return ErrInvalidSpaceField
	}
	if input.RecurringPolicy, err = utilities.OptionalNullableJSON(input.RecurringPolicy); err != nil {
		return ErrInvalidSpaceField
	}
	if !input.AdmissionPolicy.Set {
		return nil
	}
	if input.AdmissionPolicy.Value == nil {
		return ErrInvalidAdmissionPolicy
	}
	input.AdmissionPolicy.Value, err = prepareAdmissionPolicy(input.AdmissionPolicy.Value)
	return err
}

func prepareUpdatePolicies(input *UpdateSpaceInput) error {
	recording := input.RecordingPolicy
	if err := validateSetPolicy(recording.Set, recording.Value == nil, func() error { return recording.Value.Validate() }, ErrInvalidRecordingPolicy); err != nil {
		return err
	}
	transcription := input.TranscriptionPolicy
	return validateSetPolicy(transcription.Set, transcription.Value == nil, func() error { return transcription.Value.Validate() }, ErrInvalidTranscriptionPolicy)
}

// validateSetPolicy rejects a policy the request sets to null or to an invalid
// value. A policy the request leaves out is not checked.
func validateSetPolicy(set, null bool, validate func() error, invalid error) error {
	if !set {
		return nil
	}
	if null || validate() != nil {
		return invalid
	}
	return nil
}

func prepareUpdateDurations(input *UpdateSpaceInput) error {
	defaultDuration, maximumDuration := input.DefaultEpisodeDurationSeconds, input.MaximumEpisodeDurationSeconds
	if err := validateOptionalDuration(defaultDuration, ErrInvalidEpisodeDuration); err != nil {
		return err
	}
	if err := validateOptionalDuration(maximumDuration, ErrInvalidEpisodeCeiling); err != nil {
		return err
	}
	if defaultDuration.Set && defaultDuration.Value == nil {
		return ErrInvalidEpisodeDuration
	}
	if maximumDuration.Set && maximumDuration.Value == nil {
		return ErrInvalidEpisodeCeiling
	}
	if defaultDuration.Value != nil && maximumDuration.Value != nil && defaultDuration.Set && maximumDuration.Set &&
		*defaultDuration.Value > *maximumDuration.Value {
		return ErrInvalidEpisodeCeiling
	}
	return nil
}
