package webhooks

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type EventMetadata struct {
	ID                   utilities.ID
	TenantID             utilities.ID
	Name                 EventName
	OccurredAt           time.Time
	JourneyID            utilities.ID
	ParentJourneyEventID utilities.ID
	ProducingTraceID     string
	ProducingSpanID      string
}

type SpaceSnapshot struct {
	ID, Name, Slug, MediaPlane string
	ArchivedAt                 *time.Time
	CreatedAt, UpdatedAt       time.Time
}

type EpisodeSnapshot struct {
	ID, SpaceID, Status  string
	StartedAt, EndedAt   *time.Time
	CreatedAt, UpdatedAt time.Time
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

func EncodeSpaceEvent(metadata EventMetadata, snapshot SpaceSnapshot, changedFields []string) ([]byte, [32]byte, error) {
	if err := validateSpaceEvent(metadata.Name, snapshot, changedFields); err != nil {
		return nil, [32]byte{}, err
	}
	sortedChanges := append([]string(nil), changedFields...)
	sort.Strings(sortedChanges)
	data := spaceData{Object: spaceObject{ID: snapshot.ID, Name: snapshot.Name, Slug: snapshot.Slug, MediaPlane: snapshot.MediaPlane, ArchivedAt: optionalTimestamp(snapshot.ArchivedAt), CreatedAt: timestamp(snapshot.CreatedAt), UpdatedAt: timestamp(snapshot.UpdatedAt)}}
	if metadata.Name == EventSpaceUpdated {
		data.ChangedFields = sortedChanges
	}
	return encodeEvent(metadata, data)
}

func EncodeEpisodeEvent(metadata EventMetadata, snapshot EpisodeSnapshot) ([]byte, [32]byte, error) {
	if !metadata.Name.isOneOf(EventEpisodeStarted, EventEpisodeEnded) {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(snapshot.ID) || !validUUIDv4(snapshot.SpaceID) || snapshot.CreatedAt.IsZero() || snapshot.UpdatedAt.IsZero() {
		return nil, [32]byte{}, errors.New("invalid episode identity")
	}
	if metadata.Name == EventEpisodeStarted && (snapshot.Status != "active" || zeroTime(snapshot.StartedAt) || snapshot.EndedAt != nil) {
		return nil, [32]byte{}, errors.New("invalid episode.started snapshot")
	}
	if metadata.Name == EventEpisodeEnded && (snapshot.Status != "ended" || zeroTime(snapshot.StartedAt) || zeroTime(snapshot.EndedAt)) {
		return nil, [32]byte{}, errors.New("invalid episode.ended snapshot")
	}
	data := episodeData{Object: episodeObject{snapshot.ID, snapshot.SpaceID, snapshot.Status, optionalTimestamp(snapshot.StartedAt), optionalTimestamp(snapshot.EndedAt), timestamp(snapshot.CreatedAt), timestamp(snapshot.UpdatedAt)}}
	return encodeEvent(metadata, data)
}

func EncodeTestEvent(metadata EventMetadata, endpointID utilities.ID) ([]byte, [32]byte, error) {
	if endpointID.IsZero() || !validUUIDv4(endpointID.String()) {
		return nil, [32]byte{}, errors.New("invalid webhook endpoint id")
	}
	metadata.Name = EventEndpointTest
	data := testData{}
	data.Object.EndpointID = endpointID.String()
	return encodeEvent(metadata, data)
}

func EncodeRecordingEvent(metadata EventMetadata, s RecordingSnapshot) ([]byte, [32]byte, error) {
	if !metadata.Name.isOneOf(EventRecordingStarted, EventRecordingCompleted, EventRecordingFailed) {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validRecordingID(s.ID) || !validUUIDv4(s.SpaceID) || !validUUIDv4(s.EpisodeID) || s.CreatedAt.IsZero() || s.UpdatedAt.IsZero() {
		return nil, [32]byte{}, errors.New("invalid recording identity")
	}
	if err := validateArtifactTransition(metadata.Name, s.Status, s.StartedAt, s.CompletedAt, s.FailedAt, s.Failure); err != nil {
		return nil, [32]byte{}, err
	}
	return encodeEvent(metadata, recordingData{Object: recordingObject{s.ID, s.SpaceID, s.EpisodeID, s.Status, optionalTimestamp(s.StartedAt), optionalTimestamp(s.CompletedAt), optionalTimestamp(s.FailedAt), s.Failure, timestamp(s.CreatedAt), timestamp(s.UpdatedAt)}})
}

func EncodeTranscriptEvent(metadata EventMetadata, s TranscriptSnapshot) ([]byte, [32]byte, error) {
	if !metadata.Name.isOneOf(EventTranscriptStarted, EventTranscriptCompleted, EventTranscriptFailed) {
		return nil, [32]byte{}, ErrInvalidEventType
	}
	if !validUUIDv4(s.ID) || !validRecordingID(s.RecordingID) || !validUUIDv4(s.SpaceID) || !validUUIDv4(s.EpisodeID) || s.CreatedAt.IsZero() || s.UpdatedAt.IsZero() {
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
