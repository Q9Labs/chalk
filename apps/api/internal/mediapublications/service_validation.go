package mediapublications

import (
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func validateInput(input *RecordInput) error {
	input.ConnectionID = strings.TrimSpace(input.ConnectionID)
	if input.TenantID.IsZero() || input.EpisodeID.IsZero() || input.ParticipantID.IsZero() || input.ParticipantGeneration <= 0 || input.ConnectionID == "" || strings.Contains(input.ConnectionID, "|") || len(input.Tracks) == 0 || len(input.Tracks) > len(mediaplane.AllSources) {
		return ErrInvalidPublication
	}
	seen := make(map[mediaplane.PublicationSource]struct{}, len(input.Tracks))
	for index := range input.Tracks {
		track := &input.Tracks[index]
		track.Source = track.Source.Trimmed()
		track.MID = strings.TrimSpace(track.MID)
		track.TrackName = strings.TrimSpace(track.TrackName)
		if !track.Source.Valid() || track.MID == "" || track.TrackName == "" || strings.Contains(track.TrackName, "|") {
			return ErrInvalidPublication
		}
		if _, exists := seen[track.Source]; exists {
			return ErrInvalidPublication
		}
		seen[track.Source] = struct{}{}
	}
	return nil
}

func validateCloseInput(input *CloseInput) error {
	input.ConnectionID = strings.TrimSpace(input.ConnectionID)
	input.MID = strings.TrimSpace(input.MID)
	input.Source = input.Source.Trimmed()
	input.PublicationID = strings.TrimSpace(input.PublicationID)
	if input.TenantID.IsZero() || input.EpisodeID.IsZero() || input.ParticipantID.IsZero() || input.ParticipantGeneration <= 0 || input.ConnectionID == "" || strings.Contains(input.ConnectionID, "|") {
		return ErrInvalidPublication
	}
	if !input.Source.Valid() {
		return ErrInvalidPublication
	}
	reference, err := ParseReference(input.PublicationID)
	if err != nil || reference.Version != 1 || !reference.HasMID || !reference.HasParticipantGeneration ||
		reference.ConnectionID != input.ConnectionID || reference.MID != input.MID || reference.ParticipantGeneration != input.ParticipantGeneration {
		return ErrInvalidPublication
	}
	return nil
}
