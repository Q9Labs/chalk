package transcripts

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type CreateInput struct {
	ID          utilities.ID
	TenantID    utilities.ID
	RecordingID utilities.ID
	RoomID      utilities.ID
	SessionID   utilities.ID
	Status      string
	Provider    string
	Model       string
	Languages   []string
	Text        *string
	Metadata    json.RawMessage
	CompletedAt *time.Time
}

type UpdateInput struct {
	Status      utilities.OptionalString
	Provider    utilities.OptionalString
	Model       utilities.OptionalString
	Languages   OptionalStrings
	Text        utilities.OptionalString
	Metadata    utilities.OptionalJSON
	CompletedAt OptionalTime
}

type OptionalStrings struct {
	Set   bool
	Value []string
}

func (s *OptionalStrings) UnmarshalJSON(data []byte) error {
	s.Set = true

	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		s.Value = nil
		return nil
	}

	return json.Unmarshal(data, &s.Value)
}

type OptionalTime struct {
	Set   bool
	Value *time.Time
}

type TranscriptList struct {
	Transcripts []Transcript
	Page        pagination.Page
}
