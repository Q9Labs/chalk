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

type SpaceSnapshot struct {
	ID, Name, Slug, MediaPlane string
	CreatedAt, UpdatedAt       time.Time
}
type EpisodeSnapshot struct {
	ID, SpaceID, Status  string
	StartedAt, EndedAt   *time.Time
	CreatedAt, UpdatedAt time.Time
}
type ParticipantSnapshot struct {
	ID                 string
	IdentityID         *string
	SpaceID, EpisodeID string
	Name               *string
	Status             string
	JoinedAt           time.Time
	LeftAt             *time.Time
}
type ArtifactFailure struct {
	Code string `json:"code"`
}
type RecordingSnapshot struct {
	ID, SpaceID, EpisodeID, Status   string
	StartedAt, CompletedAt, FailedAt *time.Time
	Failure                          *ArtifactFailure
	CreatedAt, UpdatedAt             time.Time
}
type TranscriptSnapshot struct {
	ID, RecordingID, SpaceID, EpisodeID, Status string
	Languages                                   []string
	StartedAt, CompletedAt, FailedAt            *time.Time
	Failure                                     *ArtifactFailure
	CreatedAt, UpdatedAt                        time.Time
}

type eventEnvelope[T any] struct {
	ID         string `json:"id"`
	Event      string `json:"event"`
	APIVersion int    `json:"api_version"`
	OccurredAt string `json:"occurred_at"`
	TenantID   string `json:"tenant_id"`
	Data       T      `json:"data"`
}
type spaceData struct {
	Object        spaceObject `json:"object"`
	ChangedFields []string    `json:"changed_fields,omitempty"`
}
type spaceObject struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	MediaPlane string `json:"media_plane"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}
type episodeData struct {
	Object episodeObject `json:"object"`
}
type episodeObject struct {
	ID        string  `json:"id"`
	SpaceID   string  `json:"space_id"`
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
	ID         string  `json:"id"`
	IdentityID *string `json:"identity_id"`
	SpaceID    string  `json:"space_id"`
	EpisodeID  string  `json:"episode_id"`
	Name       *string `json:"name"`
	Status     string  `json:"status"`
	JoinedAt   string  `json:"joined_at"`
	LeftAt     *string `json:"left_at"`
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
	SpaceID     string           `json:"space_id"`
	EpisodeID   string           `json:"episode_id"`
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
	SpaceID     string           `json:"space_id"`
	EpisodeID   string           `json:"episode_id"`
	Status      string           `json:"status"`
	Languages   []string         `json:"languages"`
	StartedAt   *string          `json:"started_at"`
	CompletedAt *string          `json:"completed_at"`
	FailedAt    *string          `json:"failed_at"`
	Failure     *ArtifactFailure `json:"failure"`
	CreatedAt   string           `json:"created_at"`
	UpdatedAt   string           `json:"updated_at"`
}

func EncodeSpaceEvent(metadata EventMetadata, snapshot SpaceSnapshot, changedFields []string) ([]byte, [32]byte, error) {
	if metadata.Name != "space.created" && metadata.Name != "space.updated" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if metadata.Name == "space.updated" && len(changedFields) == 0 {
		return nil, [32]byte{}, errors.New("space.updated requires changed_fields")
	}
	if metadata.Name != "space.updated" && len(changedFields) != 0 {
		return nil, [32]byte{}, errors.New("changed_fields only applies to space.updated")
	}
	if !validUUIDv4(snapshot.ID) || snapshot.CreatedAt.IsZero() || snapshot.UpdatedAt.IsZero() {
		return nil, [32]byte{}, errors.New("invalid space snapshot")
	}
	allowedChanges := map[string]struct{}{"admission_policy": {}, "default_episode_duration_seconds": {}, "linger_window_seconds": {}, "maximum_episode_duration_seconds": {}, "media_plane": {}, "metadata": {}, "name": {}, "recurring_policy": {}, "slug": {}}
	seenChanges := make(map[string]struct{}, len(changedFields))
	for _, field := range changedFields {
		if _, ok := allowedChanges[field]; !ok {
			return nil, [32]byte{}, errors.New("invalid space changed_fields")
		}
		if _, duplicate := seenChanges[field]; duplicate {
			return nil, [32]byte{}, errors.New("duplicate space changed_fields")
		}
		seenChanges[field] = struct{}{}
	}
	sortedChanges := append([]string(nil), changedFields...)
	sort.Strings(sortedChanges)
	data := spaceData{Object: spaceObject{snapshot.ID, snapshot.Name, snapshot.Slug, snapshot.MediaPlane, timestamp(snapshot.CreatedAt), timestamp(snapshot.UpdatedAt)}}
	if metadata.Name == "space.updated" {
		data.ChangedFields = sortedChanges
	}
	return encodeEvent(metadata, data)
}

func EncodeEpisodeEvent(metadata EventMetadata, snapshot EpisodeSnapshot) ([]byte, [32]byte, error) {
	if metadata.Name != "episode.started" && metadata.Name != "episode.ended" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(snapshot.ID) || !validUUIDv4(snapshot.SpaceID) || snapshot.CreatedAt.IsZero() || snapshot.UpdatedAt.IsZero() {
		return nil, [32]byte{}, errors.New("invalid episode identity")
	}
	if metadata.Name == "episode.started" && (snapshot.Status != "active" || zeroTime(snapshot.StartedAt) || snapshot.EndedAt != nil) {
		return nil, [32]byte{}, errors.New("invalid episode.started snapshot")
	}
	if metadata.Name == "episode.ended" && (snapshot.Status != "ended" || zeroTime(snapshot.StartedAt) || zeroTime(snapshot.EndedAt)) {
		return nil, [32]byte{}, errors.New("invalid episode.ended snapshot")
	}
	data := episodeData{Object: episodeObject{snapshot.ID, snapshot.SpaceID, snapshot.Status, optionalTimestamp(snapshot.StartedAt), optionalTimestamp(snapshot.EndedAt), timestamp(snapshot.CreatedAt), timestamp(snapshot.UpdatedAt)}}
	return encodeEvent(metadata, data)
}

func EncodeParticipantEvent(metadata EventMetadata, snapshot ParticipantSnapshot) ([]byte, [32]byte, error) {
	if metadata.Name != "participant.joined" && metadata.Name != "participant.left" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(snapshot.ID) || !validUUIDv4(snapshot.SpaceID) || !validUUIDv4(snapshot.EpisodeID) || snapshot.JoinedAt.IsZero() || (snapshot.IdentityID != nil && !validUUIDv4(*snapshot.IdentityID)) {
		return nil, [32]byte{}, errors.New("invalid participant identity")
	}
	if metadata.Name == "participant.joined" && (snapshot.Status != "active" || snapshot.LeftAt != nil) {
		return nil, [32]byte{}, errors.New("invalid participant.joined snapshot")
	}
	if metadata.Name == "participant.left" && (snapshot.Status != "left" || zeroTime(snapshot.LeftAt)) {
		return nil, [32]byte{}, errors.New("invalid participant.left snapshot")
	}
	data := participantData{Object: participantObject{snapshot.ID, snapshot.IdentityID, snapshot.SpaceID, snapshot.EpisodeID, snapshot.Name, snapshot.Status, timestamp(snapshot.JoinedAt), optionalTimestamp(snapshot.LeftAt)}}
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
	if !validUUIDv4(s.ID) || !validUUIDv4(s.SpaceID) || !validUUIDv4(s.EpisodeID) || s.CreatedAt.IsZero() || s.UpdatedAt.IsZero() {
		return nil, [32]byte{}, errors.New("invalid recording identity")
	}
	if err := validateArtifactTransition(metadata.Name, s.Status, s.StartedAt, s.CompletedAt, s.FailedAt, s.Failure); err != nil {
		return nil, [32]byte{}, err
	}
	return encodeEvent(metadata, recordingData{Object: recordingObject{s.ID, s.SpaceID, s.EpisodeID, s.Status, optionalTimestamp(s.StartedAt), optionalTimestamp(s.CompletedAt), optionalTimestamp(s.FailedAt), s.Failure, timestamp(s.CreatedAt), timestamp(s.UpdatedAt)}})
}
func EncodeTranscriptEvent(metadata EventMetadata, s TranscriptSnapshot) ([]byte, [32]byte, error) {
	if metadata.Name != "transcript.started" && metadata.Name != "transcript.completed" && metadata.Name != "transcript.failed" {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(s.ID) || !validUUIDv4(s.RecordingID) || !validUUIDv4(s.SpaceID) || !validUUIDv4(s.EpisodeID) || s.CreatedAt.IsZero() || s.UpdatedAt.IsZero() {
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
	return encodeEvent(metadata, transcriptData{Object: transcriptObject{s.ID, s.RecordingID, s.SpaceID, s.EpisodeID, s.Status, languages, optionalTimestamp(s.StartedAt), optionalTimestamp(s.CompletedAt), optionalTimestamp(s.FailedAt), s.Failure, timestamp(s.CreatedAt), timestamp(s.UpdatedAt)}})
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
