package transcripts

import (
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func prepareCreateInput(input *CreateInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.RecordingID.IsZero() {
		return ErrInvalidRecordingID
	}
	if input.RoomID.IsZero() {
		return ErrInvalidRoomID
	}
	if input.SessionID.IsZero() {
		return ErrInvalidSessionID
	}

	status, err := transcriptStatus(input.Status)
	if err != nil {
		return err
	}
	input.Status = status

	if input.Status == StatusPending || input.Status == StatusProcessing || input.Status == StatusCompleted || input.Status == StatusFailed {
		// Compatibility values are accepted only by internal callers. New
		// requests use the ratified lifecycle below.
	} else {
		provider, err := utilities.RequiredString(input.Provider)
		if err != nil {
			return ErrInvalidProvider
		}
		input.Provider = provider
		model, err := utilities.RequiredString(input.Model)
		if err != nil {
			return ErrInvalidModel
		}
		input.Model = model
	}

	languages, err := languageList(input.Languages)
	if err != nil {
		return err
	}
	input.Languages = languages

	input.Text, err = utilities.NullableString(input.Text)
	if err != nil {
		return ErrInvalidTranscriptField
	}
	input.Metadata, err = utilities.JSON(input.Metadata)
	if err != nil {
		return ErrInvalidTranscriptField
	}

	return nil
}

func prepareUpdateInput(input *UpdateInput) error {
	var err error

	input.Status, err = optionalStatus(input.Status)
	if err != nil {
		return err
	}
	input.Provider, err = requiredOptionalString(input.Provider, ErrInvalidProvider)
	if err != nil {
		return err
	}
	input.Model, err = requiredOptionalString(input.Model, ErrInvalidModel)
	if err != nil {
		return err
	}
	if input.Languages.Set {
		if input.Languages.Value == nil {
			return ErrInvalidLanguages
		}
		input.Languages.Value, err = languageList(input.Languages.Value)
		if err != nil {
			return err
		}
	}
	input.Text, err = utilities.OptionalNullableString(input.Text)
	if err != nil {
		return ErrInvalidTranscriptField
	}
	input.Metadata, err = utilities.OptionalNullableJSON(input.Metadata)
	if err != nil {
		return ErrInvalidTranscriptField
	}

	return nil
}

func languageList(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, ErrInvalidLanguages
	}

	languages := make([]string, 0, len(values))
	for _, value := range values {
		language, err := utilities.RequiredString(value)
		if err != nil {
			return nil, ErrInvalidLanguages
		}
		languages = append(languages, language)
	}

	return languages, nil
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

func optionalStatus(value utilities.OptionalString) (utilities.OptionalString, error) {
	if !value.Set {
		return value, nil
	}
	if value.Value == nil {
		return utilities.OptionalString{}, ErrInvalidTranscriptStatus
	}

	status, err := transcriptStatus(*value.Value)
	if err != nil {
		return utilities.OptionalString{}, err
	}

	return utilities.OptionalString{Set: true, Value: &status}, nil
}

func transcriptStatus(value string) (string, error) {
	status, err := utilities.RequiredString(value)
	if err != nil {
		return "", ErrInvalidTranscriptStatus
	}
	switch status {
	case StatusPending, StatusProcessing, StatusCompleted, StatusFailed,
		StatusNotRequested, StatusPreparing, StatusTranscribing, StatusVerifying,
		StatusComplete, StatusRetryableFailure, StatusTerminalFailure, StatusDeleted:
		return status, nil
	default:
		return "", ErrInvalidTranscriptStatus
	}
}
