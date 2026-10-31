package mediapublications

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	receiveHealthInterval        = 5 * time.Second
	receiveHealthGrace           = 15 * time.Second
	receiveHealthSummaryInterval = time.Minute
	receiveHealthTTL             = 2 * time.Minute
	receiveHealthMaxEpisodes     = 128
	receiveHealthMaxParticipants = 128
	receiveHealthMaxPublications = 128
	receiveHealthMaxPairs        = 1024
)

type ReceiveHealthEpisode struct {
	TenantID  utilities.ID
	SpaceID   utilities.ID
	EpisodeID utilities.ID
}

type ReceiveHealthRepository interface {
	ListReceiveHealthEpisodes(context.Context, int) ([]ReceiveHealthEpisode, error)
}

type ListenerPullInput struct {
	ReceiveHealthEpisode
	ParticipantID         utilities.ID
	ParticipantGeneration int64
	ConnectionID          string
	Requested             []mediaplane.Track
	Response              mediaplane.TracksResponse
	Err                   error
}

type ListenerPullObserver interface {
	ObserveListenerPull(context.Context, ListenerPullInput)
}

type receivePairKey struct {
	listener    utilities.ID
	publication string
}

type receivePair struct {
	since      time.Time
	generation int64
	connection [32]byte
	active     bool
	reported   bool
	step       string
	errorKind  string
}

type receiveEpisode struct {
	pairs       map[receivePairKey]*receivePair
	lastSeen    time.Time
	lastSummary time.Time
	truncated   bool
}

type receiveHealth struct {
	mu          sync.Mutex
	now         func() time.Time
	episodes    map[ReceiveHealthEpisode]*receiveEpisode
	lastWarning time.Time
}

func newReceiveHealth(now func() time.Time) *receiveHealth {
	return &receiveHealth{now: now, episodes: make(map[ReceiveHealthEpisode]*receiveEpisode)}
}

// RunReceiveHealth discovers listeners independently of signaling requests.
// The state is diagnostic only; it never changes publication or pull behavior.
func (s Service) RunReceiveHealth(ctx context.Context) {
	ticker := time.NewTicker(receiveHealthInterval)
	defer ticker.Stop()
	defer s.receiveHealth.clear()
	for {
		s.sampleReceiveHealth(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (h *receiveHealth) clear() {
	h.mu.Lock()
	defer h.mu.Unlock()
	clear(h.episodes)
}

func (s Service) sampleReceiveHealth(ctx context.Context) {
	repository, ok := s.repository.(ReceiveHealthRepository)
	if !ok {
		return
	}
	episodes, err := repository.ListReceiveHealthEpisodes(ctx, receiveHealthMaxEpisodes+1)
	h := s.receiveHealth
	h.mu.Lock()
	now := h.now()
	active := make(map[ReceiveHealthEpisode]bool, len(episodes))
	for _, episode := range episodes {
		active[episode] = true
	}
	for key, episode := range h.episodes {
		if (err == nil && !active[key]) || now.Sub(episode.lastSeen) > receiveHealthTTL {
			delete(h.episodes, key)
		}
	}
	if err != nil || len(episodes) > receiveHealthMaxEpisodes {
		h.warn(ctx, now)
	}
	h.mu.Unlock()
	if err != nil {
		return
	}
	for index, episode := range episodes {
		if index == receiveHealthMaxEpisodes {
			break
		}
		publications, participants, err := s.receiveHealthSnapshot(ctx, episode)
		if err != nil {
			h.mu.Lock()
			h.warn(ctx, h.now())
			h.mu.Unlock()
			continue
		}
		h.mu.Lock()
		state := h.reconcile(episode, publications, participants)
		if state != nil {
			h.emit(ctx, episode, state)
		}
		h.mu.Unlock()
	}
}

func (s Service) receiveHealthSnapshot(ctx context.Context, episode ReceiveHealthEpisode) ([]provideroperations.Publication, []PublicationParticipant, error) {
	var publications []provideroperations.Publication
	var err error
	if reader, ok := s.repository.(interface {
		LatestObservation(context.Context, utilities.ID, utilities.ID) (provideroperations.Observation, error)
	}); ok {
		var latest provideroperations.Observation
		latest, err = reader.LatestObservation(ctx, episode.TenantID, episode.EpisodeID)
		if errors.Is(err, provideroperations.ErrObservationNotFound) {
			err = nil
		}
		publications = latest.Publications
	} else {
		var latest *provideroperations.Observation
		latest, err = s.latest(ctx, episode.TenantID, episode.EpisodeID)
		if latest != nil {
			publications = latest.Publications
		}
	}
	if err != nil {
		return nil, nil, err
	}
	participants, err := s.repository.ListPublicationParticipants(ctx, episode.TenantID, episode.EpisodeID)
	return publications, participants, err
}

func (s Service) ObserveListenerPull(ctx context.Context, input ListenerPullInput) {
	remote := false
	for _, track := range input.Requested {
		remote = remote || track.Location == "remote"
	}
	if !remote {
		return
	}
	publications, participants, err := s.receiveHealthSnapshot(ctx, input.ReceiveHealthEpisode)
	if err != nil {
		return
	}
	h := s.receiveHealth
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.reconcile(input.ReceiveHealthEpisode, publications, participants)
	if state == nil {
		return
	}
	for key, pair := range state.pairs {
		if key.listener != input.ParticipantID || pair.generation != input.ParticipantGeneration || pair.connection != sha256.Sum256([]byte(input.ConnectionID)) {
			continue
		}
		reference, err := ParseReference(key.publication)
		if err != nil {
			continue
		}
		for _, track := range input.Requested {
			if track.Location != "remote" || track.SessionID != reference.ConnectionID || track.TrackName != reference.TrackName {
				continue
			}
			step, kind := listenerPullResult(track, input.Response, input.Err)
			if pair.step != "pull_succeeded" {
				pair.step, pair.errorKind = step, kind
			}
		}
	}
}

func listenerPullResult(request mediaplane.Track, response mediaplane.TracksResponse, err error) (string, string) {
	for _, failure := range response.TrackErrors {
		if failure.ConnectionID == request.SessionID && failure.TrackName == request.TrackName {
			return "pull_failed", boundedPullErrorKind(failure.Code)
		}
	}
	if err == nil || mediaplane.IsPartialRemoteTrackResponse(err) {
		for _, track := range response.Tracks {
			if track.Location == "remote" && track.SessionID == request.SessionID && track.TrackName == request.TrackName && track.Mid != "" {
				return "pull_succeeded", ""
			}
		}
	}
	if err != nil {
		return "pull_failed", "request_failed"
	}
	return "pull_failed", "missing_result"
}

func boundedPullErrorKind(kind string) string {
	switch kind {
	case "invalid_request", "invalid_track", "connection_not_found", "connection_not_connected", "track_not_found", "empty_track_error", "unauthorized", "rate_limited", "timeout", "transport_error", "client_canceled", "plane_unavailable", "invalid_json", "invalid_contract", "provider_rejected", "provider_internal":
		return kind
	default:
		return "unknown"
	}
}

func (h *receiveHealth) reconcile(key ReceiveHealthEpisode, publications []provideroperations.Publication, participants []PublicationParticipant) *receiveEpisode {
	now := h.now()
	if len(participants) == 0 {
		delete(h.episodes, key)
		return nil
	}
	state := h.episodes[key]
	if state == nil {
		if len(h.episodes) >= receiveHealthMaxEpisodes {
			h.warn(context.Background(), now)
			return nil
		}
		state = &receiveEpisode{pairs: make(map[receivePairKey]*receivePair), lastSummary: now}
		h.episodes[key] = state
	}
	state.lastSeen = now
	state.truncated = len(participants) > receiveHealthMaxParticipants || len(publications) > receiveHealthMaxPublications
	participants = participants[:min(len(participants), receiveHealthMaxParticipants)]
	publications = publications[:min(len(publications), receiveHealthMaxPublications)]
	current := make(map[utilities.ID]PublicationParticipant, len(participants))
	for _, participant := range participants {
		current[participant.ID] = participant
	}
	seen := make(map[receivePairKey]bool)
	for _, publication := range publications {
		if (publication.Source != "microphone" && publication.Source != "screen_audio") || publication.PublicationID == "" || len(publication.PublicationID) > 4096 {
			continue
		}
		reference, err := ParseReference(publication.PublicationID)
		publisher, present := current[publication.ParticipantID]
		if err != nil || !present || (reference.HasParticipantGeneration && reference.ParticipantGeneration != publisher.Generation) || (publisher.ConnectionID != "" && reference.ConnectionID != publisher.ConnectionID) {
			continue
		}
		for _, listener := range participants {
			if listener.ID == publication.ParticipantID {
				continue
			}
			pairKey := receivePairKey{listener: listener.ID, publication: publication.PublicationID}
			pair := state.pairs[pairKey]
			if pair == nil {
				if len(state.pairs) >= receiveHealthMaxPairs {
					state.truncated = true
					continue
				}
				pair = &receivePair{}
				state.pairs[pairKey] = pair
			}
			seen[pairKey] = true
			connection := sha256.Sum256([]byte(listener.ConnectionID))
			if pair.since.IsZero() || pair.generation != listener.Generation || pair.connection != connection {
				pair.since, pair.step, pair.errorKind = now, "no_pull_attempted", ""
				pair.generation, pair.connection = listener.Generation, connection
			}
			if !pair.active {
				pair.since = now
			}
			pair.active = publication.Enabled
		}
	}
	for key := range state.pairs {
		if !seen[key] {
			delete(state.pairs, key)
		}
	}
	return state
}

func (h *receiveHealth) emit(ctx context.Context, key ReceiveHealthEpisode, state *receiveEpisode) {
	now := h.now()
	counts := map[string]int{"no_pull_attempted": 0, "pull_failed": 0, "pull_succeeded": 0}
	overdue := 0
	for keyPair, pair := range state.pairs {
		if !pair.active {
			continue
		}
		counts[pair.step]++
		if pair.step == "pull_succeeded" || now.Sub(pair.since) <= receiveHealthGrace {
			continue
		}
		overdue++
		if pair.reported {
			continue
		}
		pair.reported = true
		slog.WarnContext(ctx, "Listener has not pulled an active audio publication",
			"event", "media.listener_publication_unpulled", "tenant_id", key.TenantID.String(), "space_id", key.SpaceID.String(), "episode_id", key.EpisodeID.String(),
			"participant_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(keyPair.listener.String()))), "publication_id", keyPair.publication,
			"step", pair.step, "error_kind", pair.errorKind, "duration_ms", now.Sub(pair.since).Milliseconds())
	}
	if (overdue > 0 || state.truncated) && now.Sub(state.lastSummary) >= receiveHealthSummaryInterval {
		state.lastSummary = now
		slog.WarnContext(ctx, "Episode audio publication pull health",
			"event", "media.listener_publication_summary", "tenant_id", key.TenantID.String(), "space_id", key.SpaceID.String(), "episode_id", key.EpisodeID.String(),
			"no_pull_attempted_count", counts["no_pull_attempted"], "pull_failed_count", counts["pull_failed"], "pull_succeeded_count", counts["pull_succeeded"], "overdue_count", overdue, "truncated", state.truncated)
	}
}

func (h *receiveHealth) warn(ctx context.Context, now time.Time) {
	if h.lastWarning.IsZero() || now.Sub(h.lastWarning) >= receiveHealthSummaryInterval {
		h.lastWarning = now
		slog.WarnContext(ctx, "Audio pull health sampling is incomplete", "event", "media.listener_publication_sampling_incomplete")
	}
}
