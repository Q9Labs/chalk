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
	MID       string
	TrackName string
}

type PublishedReference struct {
	Source        string
	MID           string
	TrackName     string
	PublicationID string
}

type RecordInput struct {
	TenantID              utilities.ID
	SessionID             utilities.ID
	ParticipantSessionID  utilities.ID
	ParticipantGeneration int64
	ConnectionID          string
	Tracks                []PublishedTrack
}

type CloseInput struct {
	TenantID              utilities.ID
	SessionID             utilities.ID
	ParticipantSessionID  utilities.ID
	ParticipantGeneration int64
	ConnectionID          string
	MID                   string
	Source                string
	PublicationID         string
}

type CloseDecision struct {
	ProviderCloseRequired bool
}

type Snapshot struct {
	Incarnation  int64
	Sequence     int64
	Publications []provideroperations.Publication
}

type Registry interface {
	RecordPublishedTracks(context.Context, RecordInput) ([]PublishedReference, error)
	PrepareClose(context.Context, CloseInput) (CloseDecision, error)
	RecordClosedPublication(context.Context, CloseInput) error
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

func (s Service) RecordPublishedTracks(ctx context.Context, input RecordInput) (references []PublishedReference, err error) {
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
		return nil, ErrUnavailable
	}
	if err := validateInput(&input); err != nil {
		return nil, err
	}
	references = publishedReferences(input)
	for attempt := 0; attempt < maxAppendAttempts; attempt++ {
		latest, err := s.latest(ctx, input.TenantID, input.SessionID)
		if err != nil {
			return nil, err
		}
		next := merge(latest, input, references)
		if _, err := s.repository.AppendObservation(ctx, next); err == nil {
			return references, nil
		} else if !errors.Is(err, provideroperations.ErrObservationConflict) && !errors.Is(err, provideroperations.ErrObservationStale) {
			return nil, fmt.Errorf("append media publication observation: %w", err)
		}
	}
	return nil, fmt.Errorf("append media publication observation: %w", provideroperations.ErrObservationConflict)
}

func (s Service) PrepareClose(ctx context.Context, input CloseInput) (CloseDecision, error) {
	if s.repository == nil {
		return CloseDecision{}, ErrUnavailable
	}
	if err := validateCloseInput(&input); err != nil {
		return CloseDecision{}, err
	}
	latest, err := s.latest(ctx, input.TenantID, input.SessionID)
	if err != nil {
		return CloseDecision{}, err
	}
	switch publicationCloseState(latest, input) {
	case closeStateRequired:
		return CloseDecision{ProviderCloseRequired: true}, nil
	case closeStateSatisfied:
		return CloseDecision{}, nil
	default:
		return CloseDecision{}, ErrInvalidPublication
	}
}

func (s Service) RecordClosedPublication(ctx context.Context, input CloseInput) (err error) {
	ctx, span := tracer.Start(ctx, "media_publications.close")
	outcome := "failed"
	attempts := 0
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "media publication close observation failed")
		}
		span.SetAttributes(
			attribute.String("chalk.media.publication_close.outcome", outcome),
			attribute.Int("chalk.media.publication_close.attempts", attempts),
		)
		span.End()
	}()
	if s.repository == nil {
		return ErrUnavailable
	}
	if err := validateCloseInput(&input); err != nil {
		return err
	}
	for attempt := 0; attempt < maxAppendAttempts; attempt++ {
		attempts = attempt + 1
		latest, err := s.latest(ctx, input.TenantID, input.SessionID)
		if err != nil {
			return err
		}
		next, state := disable(latest, input)
		if state == closeStateSatisfied {
			outcome = "satisfied"
			return nil
		}
		if state == closeStateStale {
			return ErrInvalidPublication
		}
		if _, err := s.repository.AppendObservation(ctx, next); err == nil {
			outcome = "confirmed"
			return nil
		} else if !errors.Is(err, provideroperations.ErrObservationConflict) && !errors.Is(err, provideroperations.ErrObservationStale) {
			return fmt.Errorf("append media publication close observation: %w", err)
		}
	}
	return fmt.Errorf("append media publication close observation: %w", provideroperations.ErrObservationConflict)
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

func merge(latest *provideroperations.Observation, input RecordInput, references []PublishedReference) provideroperations.ObservationInput {
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
	for index, track := range input.Tracks {
		publication := provideroperations.Publication{
			ParticipantSessionID: input.ParticipantSessionID,
			Source:               track.Source,
			Enabled:              true,
			PublicationID:        references[index].PublicationID,
		}
		publications[publicationKey(publication.ParticipantSessionID, publication.Source)] = publication
	}
	values := sortedPublications(publications)
	return provideroperations.ObservationInput{TenantID: input.TenantID, SessionID: input.SessionID, Incarnation: incarnation, Sequence: sequence, Publications: values}
}

type closeState uint8

const (
	closeStateSatisfied closeState = iota
	closeStateRequired
	closeStateStale
)

func publicationCloseState(latest *provideroperations.Observation, input CloseInput) closeState {
	if latest == nil {
		return closeStateSatisfied
	}
	for _, publication := range latest.Publications {
		if publication.ParticipantSessionID != input.ParticipantSessionID || publication.Source != input.Source {
			continue
		}
		if !publication.Enabled || publication.PublicationID == "" {
			return closeStateSatisfied
		}
		if publication.PublicationID != input.PublicationID {
			return closeStateStale
		}
		return closeStateRequired
	}
	return closeStateSatisfied
}

func disable(latest *provideroperations.Observation, input CloseInput) (provideroperations.ObservationInput, closeState) {
	state := publicationCloseState(latest, input)
	if state != closeStateRequired {
		return provideroperations.ObservationInput{}, state
	}
	publications := make(map[string]provideroperations.Publication, len(latest.Publications))
	for _, publication := range latest.Publications {
		publications[publicationKey(publication.ParticipantSessionID, publication.Source)] = publication
	}
	key := publicationKey(input.ParticipantSessionID, input.Source)
	publication := publications[key]
	publication.Enabled = false
	publication.PublicationID = ""
	publications[key] = publication
	return provideroperations.ObservationInput{
		TenantID:     input.TenantID,
		SessionID:    input.SessionID,
		Incarnation:  latest.Incarnation,
		Sequence:     latest.Sequence + 1,
		Publications: sortedPublications(publications),
	}, closeStateRequired
}

func publishedReferences(input RecordInput) []PublishedReference {
	references := make([]PublishedReference, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		references = append(references, PublishedReference{
			Source: track.Source, MID: track.MID, TrackName: track.TrackName,
			PublicationID: encodeReference(input.ConnectionID, track.MID, track.TrackName, input.ParticipantGeneration),
		})
	}
	return references
}

func sortedPublications(publications map[string]provideroperations.Publication) []provideroperations.Publication {
	values := make([]provideroperations.Publication, 0, len(publications))
	for _, publication := range publications {
		values = append(values, publication)
	}
	sort.Slice(values, func(left, right int) bool {
		return publicationKey(values[left].ParticipantSessionID, values[left].Source) < publicationKey(values[right].ParticipantSessionID, values[right].Source)
	})
	return values
}

func validateInput(input *RecordInput) error {
	input.ConnectionID = strings.TrimSpace(input.ConnectionID)
	if input.TenantID.IsZero() || input.SessionID.IsZero() || input.ParticipantSessionID.IsZero() || input.ParticipantGeneration <= 0 || input.ConnectionID == "" || strings.Contains(input.ConnectionID, "|") || len(input.Tracks) == 0 || len(input.Tracks) > 3 {
		return ErrInvalidPublication
	}
	seen := make(map[string]struct{}, len(input.Tracks))
	for index := range input.Tracks {
		track := &input.Tracks[index]
		track.Source = strings.TrimSpace(track.Source)
		track.MID = strings.TrimSpace(track.MID)
		track.TrackName = strings.TrimSpace(track.TrackName)
		if (track.Source != "microphone" && track.Source != "camera" && track.Source != "screen") || track.MID == "" || track.TrackName == "" || strings.Contains(track.TrackName, "|") {
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
	input.Source = strings.TrimSpace(input.Source)
	input.PublicationID = strings.TrimSpace(input.PublicationID)
	if input.TenantID.IsZero() || input.SessionID.IsZero() || input.ParticipantSessionID.IsZero() || input.ParticipantGeneration <= 0 || input.ConnectionID == "" || strings.Contains(input.ConnectionID, "|") {
		return ErrInvalidPublication
	}
	if input.Source != "microphone" && input.Source != "camera" && input.Source != "screen" {
		return ErrInvalidPublication
	}
	reference, err := ParseReference(input.PublicationID)
	if err != nil || reference.Version != 1 || !reference.HasMID || !reference.HasParticipantGeneration ||
		reference.ConnectionID != input.ConnectionID || reference.MID != input.MID || reference.ParticipantGeneration != input.ParticipantGeneration {
		return ErrInvalidPublication
	}
	return nil
}

func publicationKey(participantID utilities.ID, source string) string {
	return participantID.String() + "\x00" + source
}
