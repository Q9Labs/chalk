package mediaplane

import "strings"

func requireTracksRequest(input *TracksRequest) error {
	connectionID, err := requiredString(input.ConnectionID)
	if err != nil || len(input.Tracks) == 0 || len(input.Tracks) > MaxTracksPerRequest {
		return ErrInvalidSignalRequest
	}
	input.ConnectionID = connectionID
	for index := range input.Tracks {
		track := &input.Tracks[index]
		track.Location = strings.TrimSpace(track.Location)
		track.Mid = strings.TrimSpace(track.Mid)
		track.TrackName = strings.TrimSpace(track.TrackName)
		track.SessionID = strings.TrimSpace(track.SessionID)
		track.Source = track.Source.Trimmed()
		if err := requireSimulcastPolicy(track.Simulcast); err != nil {
			return err
		}
		if (track.Simulcast != nil && track.Location != "remote") || track.Paused != nil {
			return ErrInvalidSignalRequest
		}
		if track.TrackName == "" || (track.Location != "local" && track.Location != "remote") {
			return ErrInvalidSignalRequest
		}
		if track.Location == "local" && (track.Mid == "" || track.SessionID != "" || !track.Source.Valid()) {
			return ErrInvalidSignalRequest
		}
		if track.Location == "remote" && track.SessionID == "" {
			return ErrInvalidSignalRequest
		}
	}
	if input.SessionDescription != nil {
		if err := requireSessionDescription(input.SessionDescription); err != nil {
			return err
		}
	}
	return nil
}

// requireUpdateTracksRequest accepts a remote subscription that names its
// receiving MID and carries a simulcast policy, a pause state or both, and a local
// publication that names its MID and source and carries a pause state.
func requireUpdateTracksRequest(input *UpdateTracksRequest) error {
	connectionID, err := requiredString(input.ConnectionID)
	if err != nil || len(input.Tracks) == 0 || len(input.Tracks) > MaxTracksPerRequest {
		return ErrInvalidSignalRequest
	}
	input.ConnectionID = connectionID
	for index := range input.Tracks {
		track := &input.Tracks[index]
		track.Location = strings.TrimSpace(track.Location)
		track.Mid = strings.TrimSpace(track.Mid)
		track.TrackName = strings.TrimSpace(track.TrackName)
		track.SessionID = strings.TrimSpace(track.SessionID)
		track.Source = track.Source.Trimmed()
		if track.Location == "local" {
			if track.Mid == "" || track.TrackName == "" || track.SessionID != "" || !track.Source.Valid() || track.Paused == nil || track.Simulcast != nil {
				return ErrInvalidSignalRequest
			}
			continue
		}
		if track.Location != "remote" || track.Mid == "" || track.TrackName == "" || track.SessionID == "" || (track.Simulcast == nil && track.Paused == nil) {
			return ErrInvalidSignalRequest
		}
		if err := requireSimulcastPolicy(track.Simulcast); err != nil {
			return err
		}
	}
	return nil
}

func requireCloseTracksRequest(input *CloseTracksRequest, provider Provider) error {
	if !validProvider(input.Provider) || (provider != "" && input.Provider != provider) {
		return ErrInvalidProvider
	}

	connectionID, err := requiredString(input.ConnectionID)
	if err != nil || len(input.Tracks) == 0 || len(input.Tracks) > 64 {
		return ErrInvalidSignalRequest
	}
	input.ConnectionID = connectionID

	seen := make(map[string]struct{}, len(input.Tracks))
	for index := range input.Tracks {
		track := &input.Tracks[index]
		track.Mid = strings.TrimSpace(track.Mid)
		track.Source = track.Source.Trimmed()
		track.PublicationID = strings.TrimSpace(track.PublicationID)
		if track.Mid == "" || !track.Source.Valid() || track.PublicationID == "" {
			return ErrInvalidSignalRequest
		}
		if _, exists := seen[track.Mid]; exists {
			return ErrInvalidSignalRequest
		}
		seen[track.Mid] = struct{}{}
	}

	if input.SessionDescription != nil {
		return requireSessionDescription(input.SessionDescription)
	}

	return nil
}

func requireRenegotiateRequest(input *RenegotiateRequest) error {
	connectionID, err := requiredString(input.ConnectionID)
	if err != nil {
		return ErrInvalidSignalRequest
	}
	input.ConnectionID = connectionID
	return requireSessionDescription(&input.SessionDescription)
}

func requireSessionDescription(description *SessionDescription) error {
	description.Type = strings.TrimSpace(description.Type)
	if strings.TrimSpace(description.SDP) == "" || (description.Type != "offer" && description.Type != "answer") {
		return ErrInvalidSignalRequest
	}
	return nil
}

func requireSimulcastPolicy(policy *Simulcast) error {
	if policy == nil {
		return nil
	}
	policy.PreferredRID = strings.TrimSpace(policy.PreferredRID)
	policy.PriorityOrdering = strings.TrimSpace(policy.PriorityOrdering)
	policy.RIDNotAvailable = strings.TrimSpace(policy.RIDNotAvailable)
	validOrdering := func(value string) bool { return value == "none" || value == "asciibetical" }
	if policy.PreferredRID == "" || !validOrdering(policy.PriorityOrdering) || !validOrdering(policy.RIDNotAvailable) {
		return ErrInvalidSignalRequest
	}
	return nil
}
