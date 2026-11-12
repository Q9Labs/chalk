package episodes

import (
	"encoding/json"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func validateConfigSnapshot(raw json.RawMessage) (json.RawMessage, EpisodeConfigSnapshot, error) {
	if len(raw) == 0 {
		return nil, EpisodeConfigSnapshot{}, nil
	}
	var snapshot EpisodeConfigSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
	}
	if _, err := admissionPolicyMode(snapshot.AdmissionPolicy); err != nil {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidAdmissionPolicy
	}
	roles, err := validateRoleCapabilities(snapshot.Roles)
	if err != nil {
		return nil, EpisodeConfigSnapshot{}, err
	}
	snapshot.Roles = roles
	if snapshot.MaximumEpisodeDurationSeconds < MinimumEpisodeDurationSeconds || snapshot.MaximumEpisodeDurationSeconds > MaximumEpisodeDurationSeconds {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidMaximumDuration
	}
	if snapshot.DefaultEpisodeDurationSeconds < MinimumEpisodeDurationSeconds || snapshot.DefaultEpisodeDurationSeconds > snapshot.MaximumEpisodeDurationSeconds {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidMaximumDuration
	}
	if snapshot.LingerWindowSeconds < 0 || snapshot.LingerWindowSeconds > snapshot.MaximumEpisodeDurationSeconds {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
	}
	if snapshot.ArtifactPolicy != nil {
		if err := snapshot.ArtifactPolicy.Validate(); err != nil {
			return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
		}
	}
	if snapshot.MediaPlaneBinding != nil {
		if err := snapshot.MediaPlaneBinding.Validate(); err != nil {
			return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
		}
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return nil, EpisodeConfigSnapshot{}, ErrInvalidConfigSnapshot
	}
	return canonicalJSON(encoded), snapshot, nil
}

func admissionPolicyMode(raw json.RawMessage) (string, error) {
	var policy struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return "", ErrInvalidAdmissionPolicy
	}
	if policy.Mode != "open" && policy.Mode != "knock" {
		return "", ErrInvalidAdmissionPolicy
	}
	return policy.Mode, nil
}

func validateRoleCapabilities(input map[string][]string) (map[string][]string, error) {
	if len(input) == 0 {
		return nil, ErrInvalidRoleCapabilities
	}
	result := make(map[string][]string, len(input))
	for role, values := range input {
		roleName, err := utilities.RequiredString(role)
		if err != nil || !utf8.ValidString(roleName) || len(roleName) > 128 || len(values) > len(validCapabilities) {
			return nil, ErrInvalidRoleCapabilities
		}
		seen := make(map[string]struct{}, len(values))
		for _, capability := range values {
			if _, ok := validCapabilities[capability]; !ok {
				return nil, ErrInvalidRoleCapabilities
			}
			if _, duplicate := seen[capability]; duplicate {
				return nil, ErrInvalidRoleCapabilities
			}
			seen[capability] = struct{}{}
		}
		for _, capability := range capabilityOrder {
			if _, ok := seen[capability]; ok {
				result[roleName] = append(result[roleName], capability)
			}
		}
	}
	return result, nil
}

func participantJoinedPayload(participantID utilities.ID, displayName, role string) json.RawMessage {
	payload, _ := json.Marshal(struct {
		DisplayName   string `json:"display_name"`
		ParticipantID string `json:"participant_id"`
		Role          string `json:"role"`
	}{DisplayName: displayName, ParticipantID: participantID.String(), Role: role})
	return payload
}

func participantLeftPayload(participantID utilities.ID) json.RawMessage {
	payload, _ := json.Marshal(struct {
		ParticipantID string `json:"participant_id"`
	}{ParticipantID: participantID.String()})
	return payload
}

func validateTenantSpaceEpisodeIDs(tenantID, spaceID, episodeID utilities.ID) error {
	if tenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if spaceID.IsZero() {
		return ErrInvalidSpaceID
	}
	if episodeID.IsZero() {
		return ErrInvalidEpisodeID
	}
	return nil
}
