package mediapublications

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var (
	ErrInvalidPublication = errors.New("invalid media publication")
	ErrUnavailable        = errors.New("media publication registry unavailable")
)

const (
	observationPageSize = 100
	maxAppendAttempts   = 4
)

var tracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/mediapublications")

type Repository interface {
	AppendObservation(context.Context, provideroperations.ObservationInput) (provideroperations.Observation, error)
	ListObservations(context.Context, utilities.ID, utilities.ID, *provideroperations.Cursor, int) (provideroperations.ObservationPage, error)
}

type PublishedTrack struct {
	Source    string
	TrackName string
}

type RecordInput struct {
	TenantID             utilities.ID
	SessionID            utilities.ID
	ParticipantSessionID utilities.ID
	ConnectionID         string
	Tracks               []PublishedTrack
}

type Snapshot struct {
	Incarnation  int64
	Sequence     int64
	Publications []provideroperations.Publication
}

type Registry interface {
	RecordPublishedTracks(context.Context, RecordInput) error
	Latest(context.Context, utilities.ID, utilities.ID) (Snapshot, error)
}

type Service struct {
	repository Repository
}

func NewService(repository Repository) Service {
	return Service{repository: repository}
}

func (s Service) Latest(ctx context.Context, tenantID, sessionID utilities.ID) (Snapshot, error) {
	if s.repository == nil {
		return Snapshot{}, ErrUnavailable
	}
	if tenantID.IsZero() || sessionID.IsZero() {
		return Snapshot{}, ErrInvalidPublication
	}
	latest, err := s.latest(ctx, tenantID, sessionID)
	if err != nil {
		return Snapshot{}, err
	}
	if latest == nil {
		return Snapshot{Publications: []provideroperations.Publication{}}, nil
	}
	return Snapshot{Incarnation: latest.Incarnation, Sequence: latest.Sequence, Publications: append([]provideroperations.Publication(nil), latest.Publications...)}, nil
}

func (s Service) RecordPublishedTracks(ctx context.Context, input RecordInput) (err error) {
	ctx, span := tracer.Start(ctx, "media_publications.record")
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "media publication observation failed")
		}
		span.SetAttributes(attribute.Int("chalk.media.track_count", len(input.Tracks)))
		span.End()
	}()
	if s.repository == nil {
		return ErrUnavailable
	}
	if err := validateInput(&input); err != nil {
		return err
	}
	for attempt := 0; attempt < maxAppendAttempts; attempt++ {
		latest, err := s.latest(ctx, input.TenantID, input.SessionID)
		if err != nil {
			return err
		}
		next := merge(latest, input)
		if _, err := s.repository.AppendObservation(ctx, next); err == nil {
			return nil
		} else if !errors.Is(err, provideroperations.ErrObservationConflict) && !errors.Is(err, provideroperations.ErrObservationStale) {
			return fmt.Errorf("append media publication observation: %w", err)
		}
	}
	return fmt.Errorf("append media publication observation: %w", provideroperations.ErrObservationConflict)
}

func (s Service) latest(ctx context.Context, tenantID, sessionID utilities.ID) (*provideroperations.Observation, error) {
	var cursor *provideroperations.Cursor
	var latest *provideroperations.Observation
	for {
		page, err := s.repository.ListObservations(ctx, tenantID, sessionID, cursor, observationPageSize)
		if err != nil {
			return nil, fmt.Errorf("list media publication observations: %w", err)
		}
		if len(page.Observations) > 0 {
			value := page.Observations[len(page.Observations)-1]
			latest = &value
		}
		if page.Next == nil {
			return latest, nil
		}
		next := *page.Next
		cursor = &next
	}
}

func merge(latest *provideroperations.Observation, input RecordInput) provideroperations.ObservationInput {
	publications := make(map[string]provideroperations.Publication)
	incarnation := int64(1)
	sequence := int64(1)
	if latest != nil {
		incarnation = latest.Incarnation
		sequence = latest.Sequence + 1
		for _, publication := range latest.Publications {
			publications[publicationKey(publication.ParticipantSessionID, publication.Source)] = publication
		}
	}
	for _, track := range input.Tracks {
		publication := provideroperations.Publication{
			ParticipantSessionID: input.ParticipantSessionID,
			Source:               track.Source,
			Enabled:              true,
			PublicationID:        input.ConnectionID + "|" + track.TrackName,
		}
		publications[publicationKey(publication.ParticipantSessionID, publication.Source)] = publication
	}
	values := make([]provideroperations.Publication, 0, len(publications))
	for _, publication := range publications {
		values = append(values, publication)
	}
	sort.Slice(values, func(left, right int) bool {
		return publicationKey(values[left].ParticipantSessionID, values[left].Source) < publicationKey(values[right].ParticipantSessionID, values[right].Source)
	})
	return provideroperations.ObservationInput{TenantID: input.TenantID, SessionID: input.SessionID, Incarnation: incarnation, Sequence: sequence, Publications: values}
}

func validateInput(input *RecordInput) error {
	input.ConnectionID = strings.TrimSpace(input.ConnectionID)
	if input.TenantID.IsZero() || input.SessionID.IsZero() || input.ParticipantSessionID.IsZero() || input.ConnectionID == "" || strings.Contains(input.ConnectionID, "|") || len(input.Tracks) == 0 || len(input.Tracks) > 3 {
		return ErrInvalidPublication
	}
	seen := make(map[string]struct{}, len(input.Tracks))
	for index := range input.Tracks {
		track := &input.Tracks[index]
		track.Source = strings.TrimSpace(track.Source)
		track.TrackName = strings.TrimSpace(track.TrackName)
		if (track.Source != "microphone" && track.Source != "camera" && track.Source != "screen") || track.TrackName == "" || strings.Contains(track.TrackName, "|") {
			return ErrInvalidPublication
		}
		if _, exists := seen[track.Source]; exists {
			return ErrInvalidPublication
		}
		seen[track.Source] = struct{}{}
	}
	return nil
}

func publicationKey(participantID utilities.ID, source string) string {
	return participantID.String() + "\x00" + source
}
