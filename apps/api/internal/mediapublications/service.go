package mediapublications

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
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

// RecordPublicationAvailability changes Chalk visibility without ending the
// Cloudflare SFU track or replacing its publication identity.
func (s Service) RecordPublicationAvailability(ctx context.Context, input AvailabilityInput) error {
	if s.repository == nil {
		return ErrUnavailable
	}
	if input.TenantID.IsZero() || input.EpisodeID.IsZero() || input.ParticipantID.IsZero() ||
		input.PublicationID == "" || !input.Source.Valid() {
		return ErrInvalidPublication
	}
	for attempt := 0; attempt < maxAppendAttempts; attempt++ {
		latest, err := s.latest(ctx, input.TenantID, input.EpisodeID)
		if err != nil {
			return err
		}
		if latest == nil {
			return nil
		}
		publications := make([]provideroperations.Publication, len(latest.Publications))
		copy(publications, latest.Publications)
		found := false
		for index := range publications {
			publication := &publications[index]
			if publication.ParticipantID != input.ParticipantID || publication.Source != input.Source || publication.PublicationID != input.PublicationID {
				continue
			}
			if publication.Enabled == input.Enabled {
				return nil
			}
			publication.Enabled = input.Enabled
			found = true
			break
		}
		if !found {
			return nil
		}
		next := provideroperations.ObservationInput{TenantID: input.TenantID, EpisodeID: input.EpisodeID, Incarnation: latest.Incarnation, Sequence: latest.Sequence + 1, Publications: publications}
		if _, err := s.repository.AppendObservation(ctx, next); err == nil {
			s.receiveHealth.recordCommittedPublications(next)
			return nil
		} else if !errors.Is(err, provideroperations.ErrObservationConflict) && !errors.Is(err, provideroperations.ErrObservationStale) {
			return fmt.Errorf("append media publication availability: %w", err)
		}
	}
	return fmt.Errorf("append media publication availability: %w", provideroperations.ErrObservationConflict)
}

// Service keeps its absence evidence, receive health and liveness checks in
// process memory. That is correct only while one API process serves the
// deployment: production runs a single API container on a single node, and
// single_instance_test.go fails when the deployment stops declaring that.
type Service struct {
	repository      Repository
	absenceEvidence *remoteTrackAbsenceEvidence
	receiveHealth   *receiveHealth
	liveness        *publicationLivenessChecks
}

func NewService(repository Repository) Service {
	return newService(repository, time.Now)
}

func newService(repository Repository, now func() time.Time) Service {
	return Service{repository: repository, absenceEvidence: newRemoteTrackAbsenceEvidence(now), receiveHealth: newReceiveHealth(now), liveness: newPublicationLivenessChecks(now)}
}

func (s Service) Latest(ctx context.Context, tenantID, episodeID utilities.ID) (Snapshot, error) {
	if s.repository == nil {
		return Snapshot{}, ErrUnavailable
	}
	if tenantID.IsZero() || episodeID.IsZero() {
		return Snapshot{}, ErrInvalidPublication
	}
	for attempt := 0; attempt < maxAppendAttempts; attempt++ {
		latest, err := s.latest(ctx, tenantID, episodeID)
		if err != nil {
			return Snapshot{}, err
		}
		if latest == nil {
			return Snapshot{Publications: []provideroperations.Publication{}}, nil
		}
		participants, err := s.repository.ListPublicationParticipants(ctx, tenantID, episodeID)
		if err != nil {
			return Snapshot{}, fmt.Errorf("list current publication participants: %w", err)
		}
		current := make(map[utilities.ID]PublicationParticipant, len(participants))
		for _, participant := range participants {
			current[participant.ID] = participant
		}
		publications := append([]provideroperations.Publication(nil), latest.Publications...)
		changed := false
		for index := range publications {
			publication := &publications[index]
			if publication.PublicationID == "" || !publication.Enabled {
				continue
			}
			reference, err := ParseReference(publication.PublicationID)
			if err != nil {
				return Snapshot{}, err
			}
			participant, active := current[publication.ParticipantID]
			if active && (!reference.HasParticipantGeneration || reference.ParticipantGeneration == participant.Generation) &&
				(participant.ConnectionID == "" || reference.ConnectionID == participant.ConnectionID) {
				continue
			}
			publication.Enabled = false
			changed = true
		}
		if !changed {
			return Snapshot{Incarnation: latest.Incarnation, Sequence: latest.Sequence, Publications: publications}, nil
		}
		// Retirement changes the snapshot, so it must advance the cursor too.
		next := provideroperations.ObservationInput{TenantID: tenantID, EpisodeID: episodeID, Incarnation: latest.Incarnation, Sequence: latest.Sequence + 1, Publications: publications}
		if _, err := s.repository.AppendObservation(ctx, next); err == nil {
			s.receiveHealth.recordCommittedPublications(next)
			return Snapshot{Incarnation: next.Incarnation, Sequence: next.Sequence, Publications: publications}, nil
		} else if !errors.Is(err, provideroperations.ErrObservationConflict) && !errors.Is(err, provideroperations.ErrObservationStale) {
			return Snapshot{}, fmt.Errorf("retire media publications: %w", err)
		}
	}
	return Snapshot{}, fmt.Errorf("retire media publications: %w", provideroperations.ErrObservationConflict)
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
		latest, err := s.latest(ctx, input.TenantID, input.EpisodeID)
		if err != nil {
			return nil, err
		}
		next := merge(latest, input, references)
		if _, err := s.repository.AppendPublicationObservation(ctx, next, PublicationParticipant{ID: input.ParticipantID, Generation: input.ParticipantGeneration, ConnectionID: input.ConnectionID}); err == nil {
			s.receiveHealth.recordCommittedPublications(next)
			return references, nil
		} else if !errors.Is(err, provideroperations.ErrObservationConflict) && !errors.Is(err, provideroperations.ErrObservationStale) {
			return nil, fmt.Errorf("append media publication observation: %w", err)
		}
	}
	return nil, fmt.Errorf("append media publication observation: %w", provideroperations.ErrObservationConflict)
}

func (s Service) latest(ctx context.Context, tenantID, episodeID utilities.ID) (*provideroperations.Observation, error) {
	var cursor *provideroperations.Cursor
	var latest *provideroperations.Observation
	for {
		page, err := s.repository.ListObservations(ctx, tenantID, episodeID, cursor, observationPageSize)
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
			if publication.ParticipantID == input.ParticipantID && publication.PublicationID != "" {
				reference, err := ParseReference(publication.PublicationID)
				if err != nil || reference.ConnectionID != input.ConnectionID || (reference.HasParticipantGeneration && reference.ParticipantGeneration != input.ParticipantGeneration) {
					publication.Enabled = false
				}
			}
			publications[publicationKey(publication.ParticipantID, publication.Source)] = publication
		}
	}
	for index, track := range input.Tracks {
		publication := provideroperations.Publication{
			ParticipantID: input.ParticipantID,
			Source:        track.Source,
			Enabled:       true,
			PublicationID: references[index].PublicationID,
		}
		publications[publicationKey(publication.ParticipantID, publication.Source)] = publication
	}
	values := sortedPublications(publications)
	return provideroperations.ObservationInput{TenantID: input.TenantID, EpisodeID: input.EpisodeID, Incarnation: incarnation, Sequence: sequence, Publications: values}
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
		return publicationKey(values[left].ParticipantID, values[left].Source) < publicationKey(values[right].ParticipantID, values[right].Source)
	})
	return values
}

func publicationKey(participantID utilities.ID, source mediaplane.PublicationSource) string {
	return participantID.String() + "\x00" + string(source)
}
