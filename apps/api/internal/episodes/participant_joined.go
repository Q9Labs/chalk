package episodes

import (
	"encoding/json"

	"github.com/q9labs/chalk/platform/utilities"
)

func ParticipantJoinedPayload(participantID utilities.ID, displayName, role string) json.RawMessage {
	payload, _ := json.Marshal(struct {
		ParticipantID string `json:"participant_id"`
		DisplayName   string `json:"display_name"`
		Role          string `json:"role"`
	}{ParticipantID: participantID.String(), DisplayName: displayName, Role: role})
	return payload
}
