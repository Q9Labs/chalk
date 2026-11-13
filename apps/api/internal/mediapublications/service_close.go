package mediapublications

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

func (s Service) PrepareClose(ctx context.Context, input CloseInput) (CloseDecision, error) {
	if s.repository == nil {
		return CloseDecision{}, ErrUnavailable
	}
	if err := validateCloseInput(&input); err != nil {
		return CloseDecision{}, err
	}
	latest, err := s.latest(ctx, input.TenantID, input.EpisodeID)
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
		latest, err := s.latest(ctx, input.TenantID, input.EpisodeID)
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
			s.receiveHealth.recordCommittedPublications(next)
			outcome = "confirmed"
			return nil
		} else if !errors.Is(err, provideroperations.ErrObservationConflict) && !errors.Is(err, provideroperations.ErrObservationStale) {
			return fmt.Errorf("append media publication close observation: %w", err)
		}
	}
	return fmt.Errorf("append media publication close observation: %w", provideroperations.ErrObservationConflict)
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
		if publication.ParticipantID != input.ParticipantID || publication.Source != input.Source {
			continue
		}
		if publication.PublicationID == "" {
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
		publications[publicationKey(publication.ParticipantID, publication.Source)] = publication
	}
	key := publicationKey(input.ParticipantID, input.Source)
	publication := publications[key]
	publication.Enabled = false
	publication.PublicationID = ""
	publications[key] = publication
	return provideroperations.ObservationInput{
		TenantID:     input.TenantID,
		EpisodeID:    input.EpisodeID,
		Incarnation:  latest.Incarnation,
		Sequence:     latest.Sequence + 1,
		Publications: sortedPublications(publications),
	}, closeStateRequired
}
