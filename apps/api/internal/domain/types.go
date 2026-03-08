// Package domain contains shared domain types used across services.
// These types belong in the domain layer and should not depend on infrastructure.
package domain

import (
	"time"

	"github.com/google/uuid"
)

// ParticipantMetadata contains display and role information for a participant.
// Used across room, participant, and recording services.
type ParticipantMetadata struct {
	DisplayName string    `json:"display_name"`
	IdentityKey string    `json:"identity_key,omitempty"`
	Role        string    `json:"role"`
	JoinedAt    time.Time `json:"joined_at"`
}

// RecordingState tracks the recording state for a room.
type RecordingState struct {
	IsRecording bool       `json:"is_recording"`
	RecordingID *uuid.UUID `json:"recording_id,omitempty"`
}
