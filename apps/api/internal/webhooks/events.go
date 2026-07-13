package webhooks

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type EventMetadata struct {
	ID                   utilities.ID
	TenantID             utilities.ID
	Name                 string
	OccurredAt           time.Time
	JourneyID            utilities.ID
	ParentJourneyEventID utilities.ID
	ProducingTraceID     string
	ProducingSpanID      string
}

type RoomSnapshot struct {
	ID, Name, Slug, Status, MediaPlane string
	CreatedAt, UpdatedAt               time.Time
}
type SessionSnapshot struct {
	ID, RoomID, Status   string
	StartedAt, EndedAt   *time.Time
	CreatedAt, UpdatedAt time.Time
}
type ParticipantSnapshot struct {
	ID                string
	UserID            *string
	RoomID, SessionID string
	Name              *string
	Status            string
	JoinedAt          time.Time
	LeftAt            *time.Time
}
type ArtifactFailure struct {
	Code string `json:"code"`
}
type RecordingSnapshot struct {
	ID, RoomID, SessionID, Status    string
	StartedAt, CompletedAt, FailedAt *time.Time
	Failure                          *ArtifactFailure
	CreatedAt, UpdatedAt             time.Time
}
type TranscriptSnapshot struct {
	ID, RecordingID, RoomID, SessionID, Status string
	Languages                                  []string
	StartedAt, CompletedAt, FailedAt           *time.Time
	Failure                                    *ArtifactFailure
	CreatedAt, UpdatedAt                       time.Time
}

type eventEnvelope[T any] struct {
	ID         string `json:"id"`
	Event      string `json:"event"`
	APIVersion int    `json:"api_version"`
	OccurredAt string `json:"occurred_at"`
	TenantID   string `json:"tenant_id"`
	Data       T      `json:"data"`
}
type roomData struct {
	Object        roomObject `json:"object"`
	ChangedFields []string   `json:"changed_fields,omitempty"`
}
type roomObject struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	Status     string `json:"status"`
	MediaPlane string `json:"media_plane"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}
type sessionData struct {
	Object sessionObject `json:"object"`
}
type sessionObject struct {
	ID        string  `json:"id"`
	RoomID    string  `json:"room_id"`
	Status    string  `json:"status"`
	StartedAt *string `json:"started_at"`
	EndedAt   *string `json:"ended_at"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}
type participantData struct {
	Object participantObject `json:"object"`
}
type participantObject struct {
	ID        string  `json:"id"`
	UserID    *string `json:"user_id"`
	RoomID    string  `json:"room_id"`
	SessionID string  `json:"session_id"`
	Name      *string `json:"name"`
	Status    string  `json:"status"`
	JoinedAt  string  `json:"joined_at"`
	LeftAt    *string `json:"left_at"`
}
type testData struct {
	Object struct {
		EndpointID string `json:"endpoint_id"`
	} `json:"object"`
}
type recordingData struct {
	Object recordingObject `json:"object"`
}
type recordingObject struct {
	ID          string           `json:"id"`
	RoomID      string           `json:"room_id"`
	SessionID   string           `json:"session_id"`
	Status      string           `json:"status"`
	StartedAt   *string          `json:"started_at"`
	CompletedAt *string          `json:"completed_at"`
	FailedAt    *string          `json:"failed_at"`
	Failure     *ArtifactFailure `json:"failure"`
	CreatedAt   string           `json:"created_at"`
	UpdatedAt   string           `json:"updated_at"`
}
type transcriptData struct {
	Object transcriptObject `json:"object"`
}
type transcriptObject struct {
	ID          string           `json:"id"`
	RecordingID string           `json:"recording_id"`
	RoomID      string           `json:"room_id"`
	SessionID   string           `json:"session_id"`
	Status      string           `json:"status"`
	Languages   []string         `json:"languages"`
	StartedAt   *string          `json:"started_at"`
	CompletedAt *string          `json:"completed_at"`
	FailedAt    *string          `json:"failed_at"`
	Failure     *ArtifactFailure `json:"failure"`
	CreatedAt   string           `json:"created_at"`
	UpdatedAt   string           `json:"updated_at"`
}

func EncodeRoomEvent(metadata EventMetadata, snapshot RoomSnapshot, changedFields []string) ([]byte, [32]byte, error) {
	if metadata.Name != "room.created" && metadata.Name != "room.updated" && metadata.Name != "room.archived" && metadata.Name != "room.restored" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if metadata.Name == "room.updated" && len(changedFields) == 0 {
		return nil, [32]byte{}, errors.New("room.updated requires changed_fields")
	}
	if metadata.Name != "room.updated" && len(changedFields) != 0 {
		return nil, [32]byte{}, errors.New("changed_fields only applies to room.updated")
	}
	if !validUUIDv4(snapshot.ID) || snapshot.CreatedAt.IsZero() || snapshot.UpdatedAt.IsZero() || (snapshot.Status != "active" && snapshot.Status != "archived") {
		return nil, [32]byte{}, errors.New("invalid room snapshot")
	}
	allowedChanges := map[string]struct{}{"media_plane": {}, "metadata": {}, "name": {}, "recurring_policy": {}, "slug": {}}
	seenChanges := make(map[string]struct{}, len(changedFields))
	for _, field := range changedFields {
		if _, ok := allowedChanges[field]; !ok {
			return nil, [32]byte{}, errors.New("invalid room changed_fields")
		}
		if _, duplicate := seenChanges[field]; duplicate {
			return nil, [32]byte{}, errors.New("duplicate room changed_fields")
		}
		seenChanges[field] = struct{}{}
	}
	if (metadata.Name == "room.archived" && snapshot.Status != "archived") || (metadata.Name == "room.restored" && snapshot.Status != "active") {
		return nil, [32]byte{}, errors.New("room event status does not match transition")
	}
	sortedChanges := append([]string(nil), changedFields...)
	sort.Strings(sortedChanges)
	data := roomData{Object: roomObject{snapshot.ID, snapshot.Name, snapshot.Slug, snapshot.Status, snapshot.MediaPlane, timestamp(snapshot.CreatedAt), timestamp(snapshot.UpdatedAt)}}
	if metadata.Name == "room.updated" {
		data.ChangedFields = sortedChanges
	}
	return encodeEvent(metadata, data)
}

func EncodeSessionEvent(metadata EventMetadata, snapshot SessionSnapshot) ([]byte, [32]byte, error) {
	if metadata.Name != "session.started" && metadata.Name != "session.ended" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(snapshot.ID) || !validUUIDv4(snapshot.RoomID) || snapshot.CreatedAt.IsZero() || snapshot.UpdatedAt.IsZero() {
		return nil, [32]byte{}, errors.New("invalid session identity")
	}
	if metadata.Name == "session.started" && (snapshot.Status != "active" || zeroTime(snapshot.StartedAt) || snapshot.EndedAt != nil) {
		return nil, [32]byte{}, errors.New("invalid session.started snapshot")
	}
	if metadata.Name == "session.ended" && (snapshot.Status != "ended" || zeroTime(snapshot.StartedAt) || zeroTime(snapshot.EndedAt)) {
		return nil, [32]byte{}, errors.New("invalid session.ended snapshot")
	}
	data := sessionData{Object: sessionObject{snapshot.ID, snapshot.RoomID, snapshot.Status, optionalTimestamp(snapshot.StartedAt), optionalTimestamp(snapshot.EndedAt), timestamp(snapshot.CreatedAt), timestamp(snapshot.UpdatedAt)}}
	return encodeEvent(metadata, data)
}

func EncodeParticipantEvent(metadata EventMetadata, snapshot ParticipantSnapshot) ([]byte, [32]byte, error) {
	if metadata.Name != "participant.joined" && metadata.Name != "participant.left" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(snapshot.ID) || !validUUIDv4(snapshot.RoomID) || !validUUIDv4(snapshot.SessionID) || snapshot.JoinedAt.IsZero() || (snapshot.UserID != nil && !validUUIDv4(*snapshot.UserID)) {
		return nil, [32]byte{}, errors.New("invalid participant identity")
	}
	if metadata.Name == "participant.joined" && (snapshot.Status != "active" || snapshot.LeftAt != nil) {
		return nil, [32]byte{}, errors.New("invalid participant.joined snapshot")
	}
	if metadata.Name == "participant.left" && (snapshot.Status != "left" || zeroTime(snapshot.LeftAt)) {
		return nil, [32]byte{}, errors.New("invalid participant.left snapshot")
	}
	data := participantData{Object: participantObject{snapshot.ID, snapshot.UserID, snapshot.RoomID, snapshot.SessionID, snapshot.Name, snapshot.Status, timestamp(snapshot.JoinedAt), optionalTimestamp(snapshot.LeftAt)}}
	return encodeEvent(metadata, data)
}

func EncodeTestEvent(metadata EventMetadata, endpointID utilities.ID) ([]byte, [32]byte, error) {
	if endpointID.IsZero() || !validUUIDv4(endpointID.String()) {
		return nil, [32]byte{}, errors.New("invalid webhook endpoint id")
	}
	metadata.Name = "endpoint.test"
	data := testData{}
	data.Object.EndpointID = endpointID.String()
	return encodeEvent(metadata, data)
}

func EncodeRecordingEvent(metadata EventMetadata, s RecordingSnapshot) ([]byte, [32]byte, error) {
	if metadata.Name != "recording.started" && metadata.Name != "recording.completed" && metadata.Name != "recording.failed" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(s.ID) || !validUUIDv4(s.RoomID) || !validUUIDv4(s.SessionID) || s.CreatedAt.IsZero() || s.UpdatedAt.IsZero() {
		return nil, [32]byte{}, errors.New("invalid recording identity")
	}
	if err := validateArtifactTransition(metadata.Name, s.Status, s.StartedAt, s.CompletedAt, s.FailedAt, s.Failure); err != nil {
		return nil, [32]byte{}, err
	}
	return encodeEvent(metadata, recordingData{Object: recordingObject{s.ID, s.RoomID, s.SessionID, s.Status, optionalTimestamp(s.StartedAt), optionalTimestamp(s.CompletedAt), optionalTimestamp(s.FailedAt), s.Failure, timestamp(s.CreatedAt), timestamp(s.UpdatedAt)}})
}
func EncodeTranscriptEvent(metadata EventMetadata, s TranscriptSnapshot) ([]byte, [32]byte, error) {
	if metadata.Name != "transcript.started" && metadata.Name != "transcript.completed" && metadata.Name != "transcript.failed" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(s.ID) || !validUUIDv4(s.RecordingID) || !validUUIDv4(s.RoomID) || !validUUIDv4(s.SessionID) || s.CreatedAt.IsZero() || s.UpdatedAt.IsZero() {
		return nil, [32]byte{}, errors.New("invalid transcript identity")
	}
	seenLanguages := make(map[string]struct{}, len(s.Languages))
	for _, language := range s.Languages {
		if _, duplicate := seenLanguages[language]; duplicate {
			return nil, [32]byte{}, errors.New("duplicate transcript language")
		}
		seenLanguages[language] = struct{}{}
	}
	if err := validateArtifactTransition(metadata.Name, s.Status, s.StartedAt, s.CompletedAt, s.FailedAt, s.Failure); err != nil {
		return nil, [32]byte{}, err
	}
	languages := s.Languages
	if languages == nil {
		languages = []string{}
	}
	return encodeEvent(metadata, transcriptData{Object: transcriptObject{s.ID, s.RecordingID, s.RoomID, s.SessionID, s.Status, languages, optionalTimestamp(s.StartedAt), optionalTimestamp(s.CompletedAt), optionalTimestamp(s.FailedAt), s.Failure, timestamp(s.CreatedAt), timestamp(s.UpdatedAt)}})
}

func encodeEvent[T any](metadata EventMetadata, data T) ([]byte, [32]byte, error) {
	if metadata.ID.IsZero() || metadata.TenantID.IsZero() || metadata.OccurredAt.IsZero() || !validUUIDv4(metadata.ID.String()) || !validUUIDv4(metadata.TenantID.String()) {
		return nil, [32]byte{}, errors.New("invalid webhook event metadata")
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(eventEnvelope[T]{metadata.ID.String(), metadata.Name, APIVersion, timestamp(metadata.OccurredAt), metadata.TenantID.String(), data})
	if err != nil {
		return nil, [32]byte{}, err
	}
	body := bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'})
	if len(body) > MaxBodyBytes {
		return nil, [32]byte{}, errors.New("webhook event body exceeds 256 KiB")
	}
	return body, sha256.Sum256(body), nil
}

func validateArtifactTransition(eventName, status string, startedAt, completedAt, failedAt *time.Time, failure *ArtifactFailure) error {
	if !strings.HasSuffix(eventName, "."+status) || zeroTime(startedAt) || nonNilZeroTime(completedAt) || nonNilZeroTime(failedAt) {
		return errors.New("artifact event status does not match transition")
	}
	switch status {
	case "started":
		if completedAt != nil || failedAt != nil || failure != nil {
			return errors.New("invalid started artifact snapshot")
		}
	case "completed":
		if zeroTime(completedAt) || failedAt != nil || failure != nil {
			return errors.New("invalid completed artifact snapshot")
		}
	case "failed":
		if zeroTime(failedAt) || completedAt != nil || failure == nil || len(failure.Code) < 1 || len(failure.Code) > 96 {
			return errors.New("invalid failed artifact snapshot")
		}
	default:
		return errors.New("invalid artifact status")
	}
	return nil
}

func validUUIDv4(value string) bool {
	id, err := utilities.ParseID(value)
	if err != nil || id.String() != value {
		return false
	}
	bytes := id.Bytes()
	return bytes[6]>>4 == 4 && bytes[8]>>6 == 2
}

func zeroTime(value *time.Time) bool { return value == nil || value.IsZero() }

func nonNilZeroTime(value *time.Time) bool { return value != nil && value.IsZero() }

func timestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
func optionalTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := timestamp(*value)
	return &formatted
}
