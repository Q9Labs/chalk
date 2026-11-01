package mediapublications

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

const (
	publicationLivenessDedupeWindow = 2 * time.Second
	publicationStillFailingWindow   = 30 * time.Second
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
	TenantID  utilities.ID
	EpisodeID utilities.ID
	Failed    []RemoteTrackIdentity
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
	// present records when the publisher session last listed a failing track as active.
	present map[publicationCandidateKey]time.Time
}

func newPublicationLivenessChecks(now func() time.Time) *publicationLivenessChecks {
	return &publicationLivenessChecks{now: now, claimed: make(map[publicationCandidateKey]time.Time), present: make(map[publicationCandidateKey]time.Time)}
}

// stillFailing reports whether listeners kept failing a track the publisher session lists as active.
// The first sighting is normal start-up, because the publication is announced before its media flows.
// Failures that outlast one dedupe window mean the provider will not serve the track, and only a new publication helps.
func (checks *publicationLivenessChecks) stillFailing(key publicationCandidateKey) bool {
	checks.mu.Lock()
	defer checks.mu.Unlock()
	now := checks.now()
	for candidate, seenAt := range checks.present {
		if now.Sub(seenAt) >= publicationStillFailingWindow {
			delete(checks.present, candidate)
		}
	}
	if _, ok := checks.present[key]; ok {
		delete(checks.present, key)
		return true
	}
	checks.present[key] = now
	return false
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
	for identity := range failed {
		slog.WarnContext(ctx, "diag confirm candidate", "event", "diag.confirm_candidate", "connection", identity.ConnectionID,
			"track", identity.TrackName, "matches", len(byIdentity[identity]), "claimed_total", len(claimed), "deduped_total", result.Deduped)
	}
	for connectionID, publications := range grouped {
		session, readErr := reader(ctx, connectionID)
		slog.WarnContext(ctx, "diag confirm read", "event", "diag.confirm_read", "connection", connectionID, "found", session.Found,
			"tracks", len(session.Tracks), "read_error", fmt.Sprint(readErr), "ctx_err", fmt.Sprint(ctx.Err()))
		if readErr != nil {
			result.Failed += len(publications)
			slog.WarnContext(ctx, "failed to inspect publisher session after remote track failure",
				"event", "media_publication.publisher_session_inspection_failed",
				"diag_error", regexp.MustCompile(`[0-9A-Za-z_-]{20,}`).ReplaceAllString(readErr.Error(), "<id>"),
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
			if present && !s.liveness.stillFailing(candidate.key) {
				result.Present++
				continue
			}
			closeErr := s.RecordClosedPublication(ctx, candidate.closeInput)
			if errors.Is(closeErr, ErrInvalidPublication) {
				continue
			}
			if closeErr != nil {
				return result, closeErr
			}
			s.absenceEvidence.forget(candidate.key)
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
