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

// Cloudflare lists a new track as active several seconds before listeners can pull it
// (rig runs saw 4.5 s of "track not found"). Only failures older than this count as a stuck track.
const publicationActiveTrackGrace = 10 * time.Second

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
	ListenerConnectionID  string
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
	mu       sync.Mutex
	now      func() time.Time
	claimed  map[publicationCandidateKey]time.Time
	evidence map[listenerEvidenceKey]map[utilities.ID]listenerReport
}

type servedKey struct {
	tenantID  string
	episodeID string
	identity  RemoteTrackIdentity
}

type listenerEvidenceKey = servedKey

type listenerReport struct {
	connectionID string
	failing      bool
	firstFailed  time.Time
	updatedAt    time.Time
}

func newPublicationLivenessChecks(now func() time.Time) *publicationLivenessChecks {
	return &publicationLivenessChecks{
		now:      now,
		claimed:  make(map[publicationCandidateKey]time.Time),
		evidence: make(map[listenerEvidenceKey]map[utilities.ID]listenerReport),
	}
}

func (checks *publicationLivenessChecks) pruneEvidenceKeyLocked(key listenerEvidenceKey, now time.Time) {
	reports := checks.evidence[key]
	for listenerID, report := range reports {
		if now.Sub(report.updatedAt) >= publicationStillFailingWindow {
			delete(reports, listenerID)
		}
	}
	if len(reports) == 0 {
		delete(checks.evidence, key)
	}
}

func (checks *publicationLivenessChecks) sweepExpiredEvidenceLocked(now time.Time) {
	for key := range checks.evidence {
		checks.pruneEvidenceKeyLocked(key, now)
	}
}

func (checks *publicationLivenessChecks) reportForWriteLocked(key listenerEvidenceKey, listenerID utilities.ID, now time.Time) map[utilities.ID]listenerReport {
	checks.pruneEvidenceKeyLocked(key, now)
	reports, exists := checks.evidence[key]
	if !exists {
		if len(checks.evidence) >= publicationLivenessEvidenceMaxKeys {
			checks.sweepExpiredEvidenceLocked(now)
			if len(checks.evidence) >= publicationLivenessEvidenceMaxKeys {
				for candidate := range checks.evidence {
					delete(checks.evidence, candidate)
					break
				}
			}
		}
		reports = make(map[utilities.ID]listenerReport)
		checks.evidence[key] = reports
	}
	if _, exists := reports[listenerID]; !exists && len(reports) >= 64 {
		var oldestID utilities.ID
		var oldest time.Time
		for candidate, report := range reports {
			if oldestID.IsZero() || report.updatedAt.Before(oldest) {
				oldestID, oldest = candidate, report.updatedAt
			}
		}
		delete(reports, oldestID)
	}
	return reports
}

func (checks *publicationLivenessChecks) recordFailure(key listenerEvidenceKey, listenerID utilities.ID, connectionID string) {
	if checks == nil || listenerID.IsZero() {
		return
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	reports := checks.reportForWriteLocked(key, listenerID, now)
	report, exists := reports[listenerID]
	if exists && report.failing && report.connectionID == connectionID && now.Sub(report.updatedAt) < publicationStillFailingWindow {
		report.updatedAt = now
		reports[listenerID] = report
		return
	}
	reports[listenerID] = listenerReport{connectionID: connectionID, failing: true, firstFailed: now, updatedAt: now}
}

func (checks *publicationLivenessChecks) recordServed(key listenerEvidenceKey, listenerID utilities.ID, connectionID string) {
	if checks == nil || listenerID.IsZero() {
		return
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	reports := checks.reportForWriteLocked(key, listenerID, now)
	reports[listenerID] = listenerReport{connectionID: connectionID, updatedAt: now}
}

// withdrawDue reports whether listeners have failed to pull an active track for longer than
// the grace period. It also returns how long the oldest counted failure has lasted.
func (checks *publicationLivenessChecks) withdrawDue(key listenerEvidenceKey, present map[utilities.ID]string) (bool, time.Duration) {
	if checks == nil {
		return false, 0
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	checks.pruneEvidenceKeyLocked(key, now)
	reports := checks.evidence[key]
	failing, served := 0, 0
	var failingFor time.Duration
	for listenerID, report := range reports {
		connectionID, isPresent := present[listenerID]
		if !isPresent || connectionID == "" || report.connectionID == "" || connectionID != report.connectionID {
			continue
		}
		if report.failing {
			failing++
			failingFor = max(failingFor, now.Sub(report.firstFailed))
		} else {
			served++
		}
	}
	return failingFor >= publicationActiveTrackGrace && (failing >= 2 || served == 0), failingFor
}

func (checks *publicationLivenessChecks) forget(candidate publicationCandidate) {
	if checks == nil {
		return
	}
	checks.mu.Lock()
	defer checks.mu.Unlock()
	delete(checks.evidence, servedKey{
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
		s.liveness.recordFailure(servedKey{tenantID: input.TenantID.String(), episodeID: input.EpisodeID.String(), identity: identity}, input.ListenerParticipantID, input.ListenerConnectionID)
		if !s.liveness.claim(candidate.key) {
			result.Deduped++
			continue
		}
		claimed[candidate.key] = struct{}{}
		grouped[candidate.closeInput.ConnectionID] = append(grouped[candidate.closeInput.ConnectionID], candidate)
	}
	result.Checked = len(claimed)
	var currentListeners map[utilities.ID]string
	presenceLoaded := false
	presenceUnavailable := false
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
			if present {
				if !presenceLoaded && !presenceUnavailable {
					participants, presenceErr := s.repository.ListPublicationParticipants(ctx, input.TenantID, input.EpisodeID)
					if presenceErr != nil {
						presenceUnavailable = true
						slog.WarnContext(ctx, "media publication listener presence unavailable",
							"event", "media_publication.listener_presence_unavailable",
						)
					} else {
						currentListeners = make(map[utilities.ID]string, len(participants))
						for _, participant := range participants {
							currentListeners[participant.ID] = participant.ConnectionID
						}
					}
					presenceLoaded = true
				}
				due, failingFor := false, time.Duration(0)
				if !presenceUnavailable {
					due, failingFor = s.liveness.withdrawDue(servedKey{tenantID: input.TenantID.String(), episodeID: input.EpisodeID.String(), identity: candidate.identity}, currentListeners)
				}
				if !due {
					result.Present++
					publicationClosuresSkipped.Add(ctx, 1)
					slog.InfoContext(ctx, "kept media publication that Cloudflare lists as active",
						"event", "media_publication.publisher_track_close_skipped",
						"listener_failing_ms", failingFor.Milliseconds(),
					)
					continue
				}
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
