package mediaplane

import (
	"errors"
	"strings"
)

func requireEpisodeBootstrapInput(input *EnsureEpisodeInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	key, err := requiredString(input.EpisodeKey)
	if err != nil {
		return ErrInvalidEpisodeKey
	}
	input.EpisodeKey = key

	if input.Title != "" {
		title, err := requiredString(input.Title)
		if err != nil {
			return ErrInvalidEpisodeKey
		}
		input.Title = title
	}

	return nil
}

func requireJoinInput(input *CreateJoinInput) error {
	if !validProvider(input.Provider) || input.Episode.Provider != input.Provider {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.Episode.Ref)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.Episode.Ref = episodeRef

	name, err := requiredString(input.ParticipantName)
	if err != nil {
		return ErrInvalidParticipantName
	}
	input.ParticipantName = name

	if input.ExternalParticipantID != "" {
		externalID, err := requiredString(input.ExternalParticipantID)
		if err != nil {
			return ErrInvalidParticipantRef
		}
		input.ExternalParticipantID = externalID
	}

	preset, err := requiredString(input.ParticipantPreset)
	if err != nil {
		return ErrInvalidParticipantPreset
	}
	input.ParticipantPreset = preset

	return nil
}

func requireResumeJoinInput(input *ResumeJoinInput, provider Provider) error {
	if !validProvider(input.Provider) || input.Episode.Provider != input.Provider || (provider != "" && input.Provider != provider) {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.Episode.Ref)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.Episode.Ref = episodeRef

	participantID, err := requiredString(input.ExternalParticipantID)
	if err != nil {
		return ErrInvalidParticipantRef
	}
	input.ExternalParticipantID = participantID

	connectionRef, err := requiredString(input.ConnectionRef)
	if err != nil {
		return ErrInvalidConnectionRef
	}
	input.ConnectionRef = connectionRef

	return nil
}

func requireParticipantRemovalInput(input *RemoveParticipantInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.EpisodeRef)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.EpisodeRef = episodeRef

	participantRef, err := requiredString(input.ParticipantRef)
	if err != nil {
		return ErrInvalidParticipantRef
	}
	input.ParticipantRef = participantRef

	return nil
}

func requireEpisodeEndInput(input *EndEpisodeInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.EpisodeRef)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.EpisodeRef = episodeRef

	return nil
}

func requireEpisodeUsageInput(input *EpisodeUsageInput) error {
	if !validProvider(input.Provider) {
		return ErrInvalidProvider
	}

	episodeRef, err := requiredString(input.EpisodeRef)
	if err != nil {
		return ErrInvalidEpisodeRef
	}
	input.EpisodeRef = episodeRef

	return nil
}

func requiredString(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("blank string")
	}

	return value, nil
}
