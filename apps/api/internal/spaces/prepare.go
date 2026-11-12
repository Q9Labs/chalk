package spaces

import (
	"crypto/sha256"
	"encoding/json"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func prepareCreateSpaceInput(input *CreateSpaceInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}

	name, err := utilities.RequiredString(input.Name)
	if err != nil || utf8.RuneCountInString(input.Name) > MaxNameCodePoints {
		return ErrInvalidSpaceName
	}
	input.Name = name

	slug, err := utilities.RequiredString(input.Slug)
	if err != nil {
		return ErrInvalidSpaceSlug
	}
	input.Slug = slug

	mediaPlane, err := utilities.RequiredString(input.MediaPlane)
	if err != nil {
		return ErrInvalidMediaPlane
	}
	provider, err := ParseMediaPlaneProvider(mediaPlane)
	if err != nil {
		return ErrInvalidMediaPlane
	}
	input.MediaPlane = string(provider)

	input.Metadata, err = utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidSpaceField
	}
	input.RecurringPolicy, err = utilities.JSON(input.RecurringPolicy)
	if err != nil {
		return ErrInvalidSpaceField
	}
	input.AdmissionPolicy, err = prepareAdmissionPolicy(input.AdmissionPolicy)
	if err != nil {
		return err
	}
	if !input.RecordingPolicySet {
		// Keep omission placeholders stable for idempotent request fingerprints.
		// The repository passes NULL so database defaults decide new-row policy.
		input.RecordingPolicy = artifactpolicy.RecordingDisabled
	}
	if !input.TranscriptionPolicySet {
		input.TranscriptionPolicy = artifactpolicy.TranscriptionDisabled
	}
	if err := input.RecordingPolicy.Validate(); err != nil {
		return ErrInvalidRecordingPolicy
	}
	if err := input.TranscriptionPolicy.Validate(); err != nil {
		return ErrInvalidTranscriptionPolicy
	}
	applySpaceDefaults(input)
	if err := validateEpisodeDurations(input.DefaultEpisodeDurationSeconds, input.MaximumEpisodeDurationSeconds); err != nil {
		return err
	}
	if err := validateLingerWindow(input.LingerWindowSeconds); err != nil {
		return err
	}
	return nil
}

func prepareUpdateSpaceInput(input *UpdateSpaceInput) error {
	var err error

	if input.Name.Set && input.Name.Value != nil && utf8.RuneCountInString(*input.Name.Value) > MaxNameCodePoints {
		return ErrInvalidSpaceName
	}
	input.Name, err = requiredOptionalString(input.Name, ErrInvalidSpaceName)
	if err != nil {
		return err
	}
	input.Slug, err = requiredOptionalString(input.Slug, ErrInvalidSpaceSlug)
	if err != nil {
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
	input.Metadata, err = utilities.OptionalNullableJSON(input.Metadata)
	if err != nil {
		return ErrInvalidSpaceField
	}
	input.RecurringPolicy, err = utilities.OptionalNullableJSON(input.RecurringPolicy)
	if err != nil {
		return ErrInvalidSpaceField
	}
	if input.AdmissionPolicy.Set {
		if input.AdmissionPolicy.Value == nil {
			return ErrInvalidAdmissionPolicy
		}
		input.AdmissionPolicy.Value, err = prepareAdmissionPolicy(input.AdmissionPolicy.Value)
		if err != nil {
			return err
		}
	}
	if input.RecordingPolicy.Set {
		if input.RecordingPolicy.Value == nil {
			return ErrInvalidRecordingPolicy
		}
		if err := input.RecordingPolicy.Value.Validate(); err != nil {
			return ErrInvalidRecordingPolicy
		}
	}
	if input.TranscriptionPolicy.Set {
		if input.TranscriptionPolicy.Value == nil {
			return ErrInvalidTranscriptionPolicy
		}
		if err := input.TranscriptionPolicy.Value.Validate(); err != nil {
			return ErrInvalidTranscriptionPolicy
		}
	}
	if err := validateOptionalDuration(input.DefaultEpisodeDurationSeconds, ErrInvalidEpisodeDuration); err != nil {
		return err
	}
	if err := validateOptionalDuration(input.MaximumEpisodeDurationSeconds, ErrInvalidEpisodeCeiling); err != nil {
		return err
	}
	if input.DefaultEpisodeDurationSeconds.Set && input.DefaultEpisodeDurationSeconds.Value == nil {
		return ErrInvalidEpisodeDuration
	}
	if input.MaximumEpisodeDurationSeconds.Set && input.MaximumEpisodeDurationSeconds.Value == nil {
		return ErrInvalidEpisodeCeiling
	}
	if input.DefaultEpisodeDurationSeconds.Set && input.MaximumEpisodeDurationSeconds.Set &&
		input.DefaultEpisodeDurationSeconds.Value != nil && input.MaximumEpisodeDurationSeconds.Value != nil &&
		*input.DefaultEpisodeDurationSeconds.Value > *input.MaximumEpisodeDurationSeconds.Value {
		return ErrInvalidEpisodeCeiling
	}
	if err := validateOptionalLingerWindow(input.LingerWindowSeconds); err != nil {
		return err
	}

	return nil
}

func prepareAdmissionPolicy(value json.RawMessage) (json.RawMessage, error) {
	value, err := utilities.JSON(value)
	if err != nil {
		return nil, ErrInvalidAdmissionPolicy
	}
	if len(value) == 0 {
		return append(json.RawMessage(nil), DefaultAdmissionPolicy...), nil
	}

	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		return nil, ErrInvalidAdmissionPolicy
	}
	// The policy is intentionally stored as a document so the admission
	// boundary can add fields without a Space migration. The mode is required
	// by the database contract; preserve additional customer policy keys.
	policy, ok := decoded.(map[string]any)
	if !ok {
		return nil, ErrInvalidAdmissionPolicy
	}
	mode, present := policy["mode"]
	if !present {
		return nil, ErrInvalidAdmissionPolicy
	}
	modeValue, ok := mode.(string)
	if !ok || !validAdmissionMode(modeValue) {
		return nil, ErrInvalidAdmissionPolicy
	}
	return value, nil
}

func validAdmissionMode(mode string) bool {
	switch mode {
	case "open", "knock":
		return true
	default:
		return false
	}
}

func applySpaceDefaults(input *CreateSpaceInput) {
	if input.DefaultEpisodeDurationSeconds == 0 {
		input.DefaultEpisodeDurationSeconds = DefaultEpisodeDurationSeconds
	}
	if input.MaximumEpisodeDurationSeconds == 0 {
		input.MaximumEpisodeDurationSeconds = DefaultMaximumEpisodeDurationSeconds
	}
	if input.LingerWindowSeconds == 0 {
		input.LingerWindowSeconds = DefaultLingerWindowSeconds
	}
}

func validateEpisodeDurations(defaultDuration, maximumDuration int32) error {
	if defaultDuration < MinimumEpisodeDurationSeconds || defaultDuration > MaximumEpisodeDurationSeconds {
		return ErrInvalidEpisodeDuration
	}
	if maximumDuration < MinimumEpisodeDurationSeconds || maximumDuration > MaximumEpisodeDurationSeconds || defaultDuration > maximumDuration {
		return ErrInvalidEpisodeCeiling
	}
	return nil
}

func validateOptionalDuration(value OptionalInt32, invalid error) error {
	if !value.Set || value.Value == nil {
		return nil
	}
	if *value.Value < MinimumEpisodeDurationSeconds || *value.Value > MaximumEpisodeDurationSeconds {
		return invalid
	}
	return nil
}

func validateLingerWindow(value int32) error {
	if value < 0 || value > MaximumEpisodeDurationSeconds {
		return ErrInvalidLingerWindow
	}
	return nil
}

func validateOptionalLingerWindow(value OptionalInt32) error {
	if !value.Set || value.Value == nil {
		if value.Set && value.Value == nil {
			return ErrInvalidLingerWindow
		}
		return nil
	}
	return validateLingerWindow(*value.Value)
}

func validateTenantSpaceIDs(tenantID utilities.ID, spaceID utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if spaceID.IsZero() {
		return ErrInvalidSpaceID
	}
	return nil
}

func requiredOptionalString(value utilities.OptionalString, invalid error) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, invalid
	}

	prepared, err := utilities.RequiredString(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, invalid
	}

	return utilities.OptionalString{Set: true, Value: &prepared}, nil
}

type createFingerprintInput struct {
	Name                          string                             `json:"name"`
	Slug                          string                             `json:"slug"`
	MediaPlane                    string                             `json:"media_plane"`
	Metadata                      json.RawMessage                    `json:"metadata"`
	RecurringPolicy               json.RawMessage                    `json:"recurring_policy"`
	AdmissionPolicy               json.RawMessage                    `json:"admission_policy"`
	RecordingPolicy               artifactpolicy.RecordingMode       `json:"recording_policy"`
	RecordingPolicySet            bool                               `json:"recording_policy_set"`
	TranscriptLanguage            *artifactpolicy.TranscriptLanguage `json:"transcript_language,omitempty"`
	TranscriptionPolicy           artifactpolicy.TranscriptionMode   `json:"transcription_policy"`
	TranscriptionPolicySet        bool                               `json:"transcription_policy_set"`
	DefaultEpisodeDurationSeconds int32                              `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32                              `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32                              `json:"linger_window_seconds"`
}

func createFingerprint(input CreateSpaceInput) ([32]byte, error) {
	payload, err := json.Marshal(createFingerprintInput{
		Name: input.Name, Slug: input.Slug, MediaPlane: input.MediaPlane,
		Metadata: input.Metadata, RecurringPolicy: input.RecurringPolicy, AdmissionPolicy: input.AdmissionPolicy,
		RecordingPolicy: input.RecordingPolicy, RecordingPolicySet: input.RecordingPolicySet,
		TranscriptionPolicy: input.TranscriptionPolicy, TranscriptionPolicySet: input.TranscriptionPolicySet,
		TranscriptLanguage:            input.TranscriptLanguage,
		DefaultEpisodeDurationSeconds: input.DefaultEpisodeDurationSeconds, MaximumEpisodeDurationSeconds: input.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds: input.LingerWindowSeconds,
	})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(payload), nil
}
