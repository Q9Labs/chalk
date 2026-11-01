package mediapublications

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

const (
	publicationLivenessDedupeWindow    = 2 * time.Second
	publicationStillFailingWindow      = 30 * time.Second
	publicationLivenessEvidenceMaxKeys = 4096
)

type PublisherTrack struct {
	MID       string
	TrackName string
	Active    bool
}

type PublisherSession struct {
	Found  bool
	Tracks []PublisherTrack
}

type PublisherSessionReader func(context.Context, string) (PublisherSession, error)

type RemoteTrackFailureInput struct {
	TenantID              utilities.ID
	EpisodeID             utilities.ID
	ListenerParticipantID utilities.ID
	Failed                []RemoteTrackIdentity
}

type RemoteTrackFailureResult struct {
	Checked int
	Closed  int
	Present int
	Deduped int
	Failed  int
}

type RemoteTrackFailureConfirmer interface {
	ConfirmRemoteTrackFailures(context.Context, RemoteTrackFailureInput, PublisherSessionReader) (RemoteTrackFailureResult, error)
}

type publicationLivenessChecks struct {
	mu      sync.Mutex
	now     func() time.Time
	claimed map[publicationCandidateKey]time.Time
	present map[publicationCandidateKey]stillFailingEvidence
	served  map[servedKey]map[utilities.ID]struct{}
}

type servedKey struct {
	tenantID  string
	episodeID string
	identity  RemoteTrackIdentity
}

type stillFailingEvidence struct {
	firstSeen time.Time
	listeners map[utilities.ID]struct{}
}

func newPublicationLivenessChecks(now func() time.Time) *publicationLivenessChecks {
	return &publicationLivenessChecks{
		now:     now,
		claimed: make(map[publicationCandidateKey]time.Time),
		present: make(map[publicationCandidateKey]stillFailingEvidence),
		served:  make(map[servedKey]map[utilities.ID]struct{}),
	}
}

func (checks *publicationLivenessChecks) stillFailing(key publicationCandidateKey, identity RemoteTrackIdentity, listenerID utilities.ID) bool {
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	for candidate, evidence := range checks.present {
		if now.Sub(evidence.firstSeen) >= publicationStillFailingWindow {
			delete(checks.present, candidate)
		}
	}
	evidence, exists := checks.present[key]
	if !exists || now.Sub(evidence.firstSeen) >= publicationStillFailingWindow {
		if !exists && len(checks.present) >= publicationLivenessEvidenceMaxKeys {
			for candidate := range checks.present {
				delete(checks.present, candidate)
				break
			}
		}
		evidence = stillFailingEvidence{firstSeen: now, listeners: make(map[utilities.ID]struct{}, 2)}
		if !listenerID.IsZero() {
			evidence.listeners[listenerID] = struct{}{}
		}
		checks.present[key] = evidence
		return false
	}
	if now.Sub(evidence.firstSeen) < publicationLivenessDedupeWindow {
		return false
	}
	if !listenerID.IsZero() && len(evidence.listeners) < 2 {
		evidence.listeners[listenerID] = struct{}{}
	}
	checks.present[key] = evidence
	if len(evidence.listeners) >= 2 {
		return true
	}
	if len(evidence.listeners) == 0 {
		return false
	}
	servedKey := servedKey{tenantID: key.tenantID, episodeID: key.episodeID, identity: identity}
	for servedBy := range checks.served[servedKey] {
		if _, reported := evidence.listeners[servedBy]; !reported {
			return false
		}
	}
	return true
}

func (checks *publicationLivenessChecks) recordServed(key servedKey, listenerID utilities.ID) {
	if checks == nil || listenerID.IsZero() {
		return
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	listeners, exists := checks.served[key]
	if !exists {
		if len(checks.served) >= publicationLivenessEvidenceMaxKeys {
			for candidate := range checks.served {
				delete(checks.served, candidate)
				break
			}
		}
		listeners = make(map[utilities.ID]struct{}, 2)
		checks.served[key] = listeners
	}
	if _, recorded := listeners[listenerID]; !recorded && len(listeners) < 2 {
		listeners[listenerID] = struct{}{}
	}
}

func (checks *publicationLivenessChecks) forget(candidate publicationCandidate) {
	if checks == nil {
		return
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	delete(checks.present, candidate.key)
	delete(checks.served, servedKey{
		tenantID:  candidate.key.tenantID,
		episodeID: candidate.key.episodeID,
		identity:  candidate.identity,
	})
}

func (checks *publicationLivenessChecks) claim(key publicationCandidateKey) bool {
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	for candidate, claimedAt := range checks.claimed {
		if now.Sub(claimedAt) >= publicationLivenessDedupeWindow {
			delete(checks.claimed, candidate)
		}
	}
	if claimedAt, ok := checks.claimed[key]; ok && now.Sub(claimedAt) < publicationLivenessDedupeWindow {
		return false
	}
	checks.claimed[key] = now
	return true
}

func (s Service) ConfirmRemoteTrackFailures(ctx context.Context, input RemoteTrackFailureInput, reader PublisherSessionReader) (result RemoteTrackFailureResult, err error) {
	ctx, span := tracer.Start(ctx, "media_publications.confirm_remote_track_failures")
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "remote track failure confirmation failed")
		}
		span.SetAttributes(
			attribute.Int("chalk.media.publication_liveness.checked_count", result.Checked),
			attribute.Int("chalk.media.publication_liveness.closed_count", result.Closed),
			attribute.Int("chalk.media.publication_liveness.present_count", result.Present),
			attribute.Int("chalk.media.publication_liveness.deduped_count", result.Deduped),
			attribute.Int("chalk.media.publication_liveness.failed_count", result.Failed),
		)
		span.End()
	}()

	if s.repository == nil || s.liveness == nil || reader == nil {
		return result, ErrUnavailable
	}
	if input.TenantID.IsZero() || input.EpisodeID.IsZero() || len(input.Failed) == 0 {
		return result, ErrInvalidPublication
	}
	failed := make(map[RemoteTrackIdentity]struct{}, len(input.Failed))
	for index := range input.Failed {
		input.Failed[index].ConnectionID = strings.TrimSpace(input.Failed[index].ConnectionID)
		input.Failed[index].TrackName = strings.TrimSpace(input.Failed[index].TrackName)
		identity := input.Failed[index]
		if identity.ConnectionID == "" || identity.TrackName == "" {
			return result, ErrInvalidPublication
		}
		failed[identity] = struct{}{}
	}

	latest, err := s.latest(ctx, input.TenantID, input.EpisodeID)
	if err != nil {
		return result, err
	}
	candidates := remotePublicationCandidates(input.TenantID, input.EpisodeID, latest)
	byIdentity := make(map[RemoteTrackIdentity][]publicationCandidate, len(candidates))
	for _, candidate := range candidates {
		byIdentity[candidate.identity] = append(byIdentity[candidate.identity], candidate)
	}
	grouped := make(map[string][]publicationCandidate)
	claimed := make(map[publicationCandidateKey]struct{})
	for identity := range failed {
		matches := byIdentity[identity]
		if len(matches) != 1 {
			continue
		}
		candidate := matches[0]
		if !s.liveness.claim(candidate.key) {
			result.Deduped++
			continue
		}
		claimed[candidate.key] = struct{}{}
		grouped[candidate.closeInput.ConnectionID] = append(grouped[candidate.closeInput.ConnectionID], candidate)
	}
	result.Checked = len(claimed)
	for connectionID, publications := range grouped {
		session, readErr := reader(ctx, connectionID)
		if readErr != nil {
			result.Failed += len(publications)
			slog.WarnContext(ctx, "failed to inspect publisher session after remote track failure",
				"event", "media_publication.publisher_session_inspection_failed",
				"publication_count", len(publications),
			)
			continue
		}
		for _, candidate := range publications {
			present := false
			if session.Found {
				for _, track := range session.Tracks {
					if track.TrackName == candidate.identity.TrackName && track.MID == candidate.closeInput.MID && track.Active {
						present = true
						break
					}
				}
			}
			if present && !s.liveness.stillFailing(candidate.key, candidate.identity, input.ListenerParticipantID) {
				result.Present++
				continue
			}
			closeErr := s.RecordClosedPublication(ctx, candidate.closeInput)
			if errors.Is(closeErr, ErrInvalidPublication) {
				s.absenceEvidence.forget(candidate.key)
				s.liveness.forget(candidate)
				continue
			}
			if closeErr != nil {
				return result, closeErr
			}
			s.absenceEvidence.forget(candidate.key)
			s.liveness.forget(candidate)
			result.Closed++
		}
	}
	if result.Closed > 0 {
		slog.InfoContext(ctx, "closed unavailable media publications after remote track failures",
			"event", "media_publication.publisher_track_closed",
			"closed_count", result.Closed,
		)
	}
	return result, nil
}
