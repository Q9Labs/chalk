package mediapublications

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

const (
	remoteTrackAbsenceMinimumObservations = 3
	remoteTrackAbsenceMinimumInterval     = 2 * time.Second
	remoteTrackAbsenceGrace               = 15 * time.Second
	remoteTrackAbsenceEvidenceTTL         = 10 * time.Minute
)

type RemoteTrackIdentity struct {
	ConnectionID string
	TrackName    string
}

type RemoteTrackObservationInput struct {
	TenantID  utilities.ID
	EpisodeID utilities.ID
	Requested []RemoteTrackIdentity
	Missing   []RemoteTrackIdentity
}

type publicationCandidate struct {
	key        publicationCandidateKey
	identity   RemoteTrackIdentity
	closeInput CloseInput
}

type publicationCandidateKey struct {
	tenantID      string
	episodeID     string
	participantID string
	source        string
	publicationID string
}

type absenceEvidence struct {
	firstObserved time.Time
	lastObserved  time.Time
	observations  int
	identity      RemoteTrackIdentity
}

type remoteTrackAbsenceEvidence struct {
	mu         sync.Mutex
	now        func() time.Time
	candidates map[publicationCandidateKey]absenceEvidence
}

func newRemoteTrackAbsenceEvidence(now func() time.Time) *remoteTrackAbsenceEvidence {
	return &remoteTrackAbsenceEvidence{now: now, candidates: make(map[publicationCandidateKey]absenceEvidence)}
}

func (s Service) ObserveRemoteTracks(ctx context.Context, input RemoteTrackObservationInput) (err error) {
	ctx, span := tracer.Start(ctx, "media_publications.observe_remote_tracks")
	outcome := "observed"
	confirmed := 0
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "remote publication reconciliation failed")
			outcome = "failed"
		}
		span.SetAttributes(
			attribute.String("chalk.media.publication_reconciliation.outcome", outcome),
			attribute.Int("chalk.media.publication_reconciliation.requested_count", len(input.Requested)),
			attribute.Int("chalk.media.publication_reconciliation.missing_count", len(input.Missing)),
			attribute.Int("chalk.media.publication_reconciliation.confirmed_count", confirmed),
		)
		publicationReconciliations.Add(ctx, 1, metric.WithAttributes(
			attribute.String("chalk.media.publication_reconciliation.outcome", outcome),
			attribute.Int("chalk.media.publication_reconciliation.missing_count", len(input.Missing)),
			attribute.Int("chalk.media.publication_reconciliation.confirmed_count", confirmed),
		))
		if err != nil {
			slog.ErrorContext(ctx, "remote publication reconciliation failed",
				slog.Int("requested_count", len(input.Requested)),
				slog.Int("missing_count", len(input.Missing)),
				slog.Int("confirmed_count", confirmed),
			)
		} else if confirmed > 0 {
			slog.InfoContext(ctx, "remote publication reconciliation confirmed provider absence",
				slog.Int("requested_count", len(input.Requested)),
				slog.Int("missing_count", len(input.Missing)),
				slog.Int("confirmed_count", confirmed),
			)
		}
		span.End()
	}()

	if s.repository == nil || s.absenceEvidence == nil {
		return ErrUnavailable
	}
	requested, missing, err := validateRemoteTrackObservation(&input)
	if err != nil {
		return err
	}
	s.absenceEvidence.resetPresent(input.TenantID, input.EpisodeID, requested, missing)
	if len(missing) == 0 {
		return nil
	}
	latest, err := s.latest(ctx, input.TenantID, input.EpisodeID)
	if err != nil {
		return err
	}
	candidates := remotePublicationCandidates(input.TenantID, input.EpisodeID, latest)
	due := s.absenceEvidence.observe(input.TenantID, input.EpisodeID, candidates, requested, missing)
	for _, candidate := range due {
		closeErr := s.RecordClosedPublication(ctx, candidate.closeInput)
		if closeErr == nil || errors.Is(closeErr, ErrInvalidPublication) {
			s.absenceEvidence.forget(candidate.key)
			if closeErr == nil {
				confirmed++
				outcome = "confirmed"
			}
			continue
		}
		return fmt.Errorf("reconcile missing remote publication: %w", closeErr)
	}
	return nil
}

func validateRemoteTrackObservation(input *RemoteTrackObservationInput) (map[RemoteTrackIdentity]struct{}, map[RemoteTrackIdentity]struct{}, error) {
	if input.TenantID.IsZero() || input.EpisodeID.IsZero() || len(input.Requested) == 0 {
		return nil, nil, ErrInvalidPublication
	}
	requested := make(map[RemoteTrackIdentity]struct{}, len(input.Requested))
	for index := range input.Requested {
		input.Requested[index].ConnectionID = strings.TrimSpace(input.Requested[index].ConnectionID)
		input.Requested[index].TrackName = strings.TrimSpace(input.Requested[index].TrackName)
		identity := input.Requested[index]
		if identity.ConnectionID == "" || identity.TrackName == "" {
			return nil, nil, ErrInvalidPublication
		}
		requested[identity] = struct{}{}
	}
	missing := make(map[RemoteTrackIdentity]struct{}, len(input.Missing))
	for index := range input.Missing {
		input.Missing[index].ConnectionID = strings.TrimSpace(input.Missing[index].ConnectionID)
		input.Missing[index].TrackName = strings.TrimSpace(input.Missing[index].TrackName)
		identity := input.Missing[index]
		if _, exists := requested[identity]; !exists {
			return nil, nil, ErrInvalidPublication
		}
		missing[identity] = struct{}{}
	}
	return requested, missing, nil
}

func remotePublicationCandidates(tenantID, episodeID utilities.ID, latest *provideroperations.Observation) []publicationCandidate {
	if latest == nil {
		return nil
	}
	candidates := make([]publicationCandidate, 0, len(latest.Publications))
	for _, publication := range latest.Publications {
		if !publication.Enabled || publication.PublicationID == "" {
			continue
		}
		reference, err := ParseReference(publication.PublicationID)
		if err != nil || reference.Version != 1 || !reference.HasMID || !reference.HasParticipantGeneration {
			continue
		}
		candidate := publicationCandidate{
			identity: RemoteTrackIdentity{ConnectionID: reference.ConnectionID, TrackName: reference.TrackName},
			closeInput: CloseInput{
				TenantID: tenantID, EpisodeID: episodeID, ParticipantID: publication.ParticipantID,
				ParticipantGeneration: reference.ParticipantGeneration, ConnectionID: reference.ConnectionID,
				MID: reference.MID, Source: publication.Source, PublicationID: publication.PublicationID,
			},
		}
		candidate.key = publicationCandidateKey{
			tenantID: tenantID.String(), episodeID: episodeID.String(), participantID: publication.ParticipantID.String(),
			source: publication.Source, publicationID: publication.PublicationID,
		}
		candidates = append(candidates, candidate)
	}
	return candidates
}

func (e *remoteTrackAbsenceEvidence) observe(tenantID, episodeID utilities.ID, candidates []publicationCandidate, requested, missing map[RemoteTrackIdentity]struct{}) []publicationCandidate {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	current := make(map[publicationCandidateKey]struct{}, len(candidates))
	byIdentity := make(map[RemoteTrackIdentity][]publicationCandidate, len(candidates))
	for _, candidate := range candidates {
		current[candidate.key] = struct{}{}
		byIdentity[candidate.identity] = append(byIdentity[candidate.identity], candidate)
	}
	for key, evidence := range e.candidates {
		_, belongsToEpisode := current[key]
		if (key.tenantID == tenantID.String() && key.episodeID == episodeID.String() && !belongsToEpisode) || now.Sub(evidence.lastObserved) > remoteTrackAbsenceEvidenceTTL {
			delete(e.candidates, key)
		}
	}
	due := make([]publicationCandidate, 0)
	for identity := range requested {
		matched := byIdentity[identity]
		if _, absent := missing[identity]; !absent {
			for _, candidate := range matched {
				delete(e.candidates, candidate.key)
			}
			continue
		}
		if len(matched) != 1 {
			continue
		}
		candidate := matched[0]
		evidence, exists := e.candidates[candidate.key]
		if !exists {
			evidence.firstObserved = now
		}
		if !exists || now.Sub(evidence.lastObserved) >= remoteTrackAbsenceMinimumInterval {
			evidence.observations++
		}
		evidence.lastObserved = now
		evidence.identity = identity
		e.candidates[candidate.key] = evidence
		if evidence.observations >= remoteTrackAbsenceMinimumObservations && now.Sub(evidence.firstObserved) >= remoteTrackAbsenceGrace {
			due = append(due, candidate)
		}
	}
	return due
}

func (e *remoteTrackAbsenceEvidence) resetPresent(tenantID, episodeID utilities.ID, requested, missing map[RemoteTrackIdentity]struct{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for key, evidence := range e.candidates {
		if key.tenantID != tenantID.String() || key.episodeID != episodeID.String() {
			continue
		}
		if _, wasRequested := requested[evidence.identity]; !wasRequested {
			continue
		}
		if _, isMissing := missing[evidence.identity]; !isMissing {
			delete(e.candidates, key)
		}
	}
}

func (e *remoteTrackAbsenceEvidence) forget(key publicationCandidateKey) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.candidates, key)
}
