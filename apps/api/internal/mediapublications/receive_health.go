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
	Capture               ListenerPullCapture
	Requested             []mediaplane.Track
	Response              mediaplane.TracksResponse
	Err                   error
}

type ListenerPullCapture struct {
	snapshot receivePublicationSnapshot
	captured bool
}

func (s Service) CaptureListenerPull(episode ReceiveHealthEpisode) ListenerPullCapture {
	if s.receiveHealth == nil {
		return ListenerPullCapture{captured: true}
	}
	return ListenerPullCapture{snapshot: s.receiveHealth.publicationSnapshot(episode, s.receiveHealth.now()), captured: true}
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
	mu          sync.Mutex
	pairs       map[receivePairKey]*receivePair
	pulls       map[receivePullKey]receivePull
	lastSeen    time.Time
	lastSummary time.Time
	truncated   bool
}

type receivePullKey struct {
	listener    utilities.ID
	generation  int64
	connection  [32]byte
	publisher   [32]byte
	track       [32]byte
	publication [32]byte
}

type receivePublicationKey struct {
	publisher [32]byte
	track     [32]byte
}

type receivePublicationEpisodeKey struct {
	tenant  utilities.ID
	episode utilities.ID
}

type receivePublicationSnapshot struct {
	incarnation int64
	sequence    int64
	commits     uint64
	updatedAt   time.Time
	identities  map[receivePublicationKey][32]byte
}

type receivePull struct {
	since     time.Time
	step      string
	errorKind string
	commits   uint64
}

type receiveHealthEvent struct {
	message string
	args    []any
}

func emitReceiveHealthEvents(ctx context.Context, events []receiveHealthEvent) {
	for _, event := range events {
		slog.WarnContext(ctx, event.message, event.args...)
	}
}

type receiveHealth struct {
	mu           sync.Mutex
	now          func() time.Time
	episodes     map[ReceiveHealthEpisode]*receiveEpisode
	publications map[receivePublicationEpisodeKey]receivePublicationSnapshot
	lastWarning  time.Time
}

func newReceiveHealth(now func() time.Time) *receiveHealth {
	return &receiveHealth{now: now, episodes: make(map[ReceiveHealthEpisode]*receiveEpisode), publications: make(map[receivePublicationEpisodeKey]receivePublicationSnapshot)}
}

// Publication identities outlive diagnostic pair resets and never bind at sample time.
func (h *receiveHealth) recordPublications(input provideroperations.ObservationInput) {
	h.updatePublications(input, false)
}

func (h *receiveHealth) recordCommittedPublications(input provideroperations.ObservationInput) {
	h.updatePublications(input, true)
}

func (h *receiveHealth) updatePublications(input provideroperations.ObservationInput, committed bool) {
	if h == nil {
		return
	}
	identities := make(map[receivePublicationKey][32]byte)
	for _, publication := range input.Publications[:min(len(input.Publications), receiveHealthMaxPublications)] {
		if (publication.Source != "microphone" && publication.Source != "screen_audio") || len(publication.PublicationID) > 4096 {
			continue
		}
		reference, err := ParseReference(publication.PublicationID)
		if err != nil {
			continue
		}
		key := receivePublicationKey{publisher: sha256.Sum256([]byte(reference.ConnectionID)), track: sha256.Sum256([]byte(reference.TrackName))}
		identities[key] = sha256.Sum256([]byte(publication.PublicationID))
	}
	now := h.now()
	key := receivePublicationEpisodeKey{tenant: input.TenantID, episode: input.EpisodeID}
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, snapshot := range h.publications {
		if now.Sub(snapshot.updatedAt) > receiveHealthTTL {
			delete(h.publications, key)
		}
	}
	previous, exists := h.publications[key]
	if committed {
		previous.commits++
	}
	if exists && (input.Incarnation < previous.incarnation || (input.Incarnation == previous.incarnation && input.Sequence < previous.sequence)) {
		if committed {
			h.publications[key] = previous
		}
		return
	}
	if !exists && len(h.publications) >= receiveHealthMaxEpisodes {
		return
	}
	h.publications[key] = receivePublicationSnapshot{incarnation: input.Incarnation, sequence: input.Sequence, commits: previous.commits, updatedAt: now, identities: identities}
}

func (h *receiveHealth) publicationSnapshot(episode ReceiveHealthEpisode, now time.Time) receivePublicationSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	snapshot := h.publications[receivePublicationEpisodeKey{tenant: episode.TenantID, episode: episode.EpisodeID}]
	if now.Sub(snapshot.updatedAt) > receiveHealthTTL {
		snapshot.identities = nil
	}
	return snapshot
}

func (h *receiveHealth) publicationIdentities(episode ReceiveHealthEpisode, now time.Time) map[receivePublicationKey][32]byte {
	return h.publicationSnapshot(episode, now).identities
}

// RunReceiveHealth discovers listeners independently of signaling requests.
// The state is diagnostic only; it never changes publication or pull behavior.
func (s Service) RunReceiveHealth(ctx context.Context) {
	ticker := time.NewTicker(receiveHealthInterval)
	defer ticker.Stop()
	defer s.receiveHealth.clear()
	defer func() {
		s.receiveHealth.mu.Lock()
		clear(s.receiveHealth.publications)
		s.receiveHealth.mu.Unlock()
	}()
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
	states := make(map[ReceiveHealthEpisode]*receiveEpisode, len(h.episodes))
	for key, state := range h.episodes {
		states[key] = state
	}
	h.mu.Unlock()
	now := h.now()
	active := make(map[ReceiveHealthEpisode]bool, len(episodes))
	for _, episode := range episodes {
		active[episode] = true
	}
	for key, episode := range states {
		episode.mu.Lock()
		expired := now.Sub(episode.lastSeen) > receiveHealthTTL
		episode.mu.Unlock()
		if (err == nil && !active[key]) || expired {
			h.mu.Lock()
			if h.episodes[key] == episode {
				delete(h.episodes, key)
			}
			h.mu.Unlock()
		}
	}
	if err != nil || len(episodes) > receiveHealthMaxEpisodes {
		h.warn(ctx, now)
	}
	if err != nil {
		return
	}
	for index, episode := range episodes {
		if index == receiveHealthMaxEpisodes {
			break
		}
		publications, participants, err := s.receiveHealthSnapshot(ctx, episode)
		if err != nil {
			h.warn(ctx, h.now())
			continue
		}
		events := h.reconcile(episode, publications, participants)
		emitReceiveHealthEvents(ctx, events)
	}
}

func (s Service) receiveHealthSnapshot(ctx context.Context, episode ReceiveHealthEpisode) ([]provideroperations.Publication, []PublicationParticipant, error) {
	var publications []provideroperations.Publication
	var observation provideroperations.Observation
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
		observation = latest
	} else {
		var latest *provideroperations.Observation
		latest, err = s.latest(ctx, episode.TenantID, episode.EpisodeID)
		if latest != nil {
			publications = latest.Publications
			observation = *latest
		}
	}
	if err != nil {
		return nil, nil, err
	}
	s.receiveHealth.recordPublications(provideroperations.ObservationInput{TenantID: episode.TenantID, EpisodeID: episode.EpisodeID,
		Incarnation: observation.Incarnation, Sequence: observation.Sequence, Publications: publications})
	participants, err := s.repository.ListPublicationParticipants(ctx, episode.TenantID, episode.EpisodeID)
	return publications, participants, err
}

func (s Service) ObserveListenerPull(_ context.Context, input ListenerPullInput) {
	remote := false
	for _, track := range input.Requested {
		remote = remote || track.Location == "remote"
	}
	if !remote {
		return
	}
	h := s.receiveHealth
	now := h.now()
	capture := input.Capture
	if !capture.captured {
		capture = s.CaptureListenerPull(input.ReceiveHealthEpisode)
	}
	snapshot := capture.snapshot
	key := receivePullKey{listener: input.ParticipantID, generation: input.ParticipantGeneration, connection: sha256.Sum256([]byte(input.ConnectionID))}
	pulls := make(map[receivePullKey]receivePull)
	for _, track := range input.Requested {
		if track.Location != "remote" {
			continue
		}
		key.publisher = sha256.Sum256([]byte(track.SessionID))
		key.track = sha256.Sum256([]byte(track.TrackName))
		key.publication = [32]byte{}
		if len(track.PublicationID) <= 4096 {
			if reference, err := ParseReference(track.PublicationID); err == nil && reference.ConnectionID == track.SessionID && reference.TrackName == track.TrackName {
				key.publication = sha256.Sum256([]byte(track.PublicationID))
			}
		}
		if key.publication == ([32]byte{}) {
			key.publication = snapshot.identities[receivePublicationKey{publisher: key.publisher, track: key.track}]
		}
		if key.publication == ([32]byte{}) && snapshot.identities != nil {
			continue
		}
		step, kind := listenerPullResult(track, input.Response, input.Err)
		pulls[key] = receivePull{since: now, step: step, errorKind: kind, commits: snapshot.commits}
		if len(pulls) == receiveHealthMaxPublications {
			break
		}
	}
	if len(pulls) == 0 {
		return
	}
	state := h.episode(input.ReceiveHealthEpisode)
	if state == nil {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	for key, pull := range pulls {
		previous, exists := state.pulls[key]
		if !exists && len(state.pulls) >= receiveHealthMaxPairs {
			state.truncated = true
			continue
		}
		if exists && now.Sub(previous.since) <= receiveHealthTTL {
			if previous.step == "pull_succeeded" {
				continue
			}
			pull.since = previous.since
		}
		state.pulls[key] = pull
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

func (h *receiveHealth) episode(key ReceiveHealthEpisode) *receiveEpisode {
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.episodes[key]
	if state == nil {
		if len(h.episodes) >= receiveHealthMaxEpisodes {
			return nil
		}
		now := h.now()
		state = &receiveEpisode{pairs: make(map[receivePairKey]*receivePair), pulls: make(map[receivePullKey]receivePull), lastSeen: now, lastSummary: now}
		h.episodes[key] = state
	}
	return state
}

func (h *receiveHealth) reconcile(key ReceiveHealthEpisode, publications []provideroperations.Publication, participants []PublicationParticipant) []receiveHealthEvent {
	if len(participants) == 0 {
		h.mu.Lock()
		delete(h.episodes, key)
		h.mu.Unlock()
		return nil
	}
	state := h.episode(key)
	if state == nil {
		h.warn(context.Background(), h.now())
		return nil
	}
	snapshot := h.publicationSnapshot(key, h.now())
	state.mu.Lock()
	defer state.mu.Unlock()
	now := h.now()
	for key, pull := range state.pulls {
		if now.Sub(pull.since) > receiveHealthTTL {
			delete(state.pulls, key)
		}
	}
	state.lastSeen = now
	state.truncated = len(participants) > receiveHealthMaxParticipants || len(publications) > receiveHealthMaxPublications || len(state.pulls) >= receiveHealthMaxPairs
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
		publicationKey := receivePublicationKey{publisher: sha256.Sum256([]byte(reference.ConnectionID)), track: sha256.Sum256([]byte(reference.TrackName))}
		publicationHash := sha256.Sum256([]byte(publication.PublicationID))
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
			fresh := pair.since.IsZero() || pair.generation != listener.Generation || pair.connection != connection
			if fresh {
				pair.since, pair.step, pair.errorKind = now, "no_pull_attempted", ""
				pair.generation, pair.connection = listener.Generation, connection
			}
			if !pair.active {
				pair.since = now
			}
			pair.active = publication.Enabled
			pullKey := receivePullKey{listener: listener.ID, generation: listener.Generation, connection: connection,
				publisher: publicationKey.publisher, track: publicationKey.track, publication: publicationHash}
			pull, ok := state.pulls[pullKey]
			delete(state.pulls, pullKey)
			pullKey.publication = [32]byte{}
			if pending, exists := state.pulls[pullKey]; exists {
				delete(state.pulls, pullKey)
				if snapshot.identities != nil && pending.commits == snapshot.commits && snapshot.identities[publicationKey] == publicationHash {
					if !ok || pending.step == "pull_succeeded" {
						pull.step, pull.errorKind = pending.step, pending.errorKind
					}
					if !ok || pending.since.Before(pull.since) {
						pull.since = pending.since
					}
					ok = true
				}
			}
			if ok && pair.step != "pull_succeeded" {
				pair.step, pair.errorKind = pull.step, pull.errorKind
				if fresh && pull.since.Before(pair.since) {
					pair.since = pull.since
				}
			}
		}
	}
	for key := range state.pairs {
		if !seen[key] {
			delete(state.pairs, key)
		}
	}
	return h.events(key, state)
}

func (h *receiveHealth) events(key ReceiveHealthEpisode, state *receiveEpisode) []receiveHealthEvent {
	var events []receiveHealthEvent
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
		events = append(events, receiveHealthEvent{"Listener has not pulled an active audio publication", []any{
			"event", "media.listener_publication_unpulled", "tenant_id", key.TenantID.String(), "space_id", key.SpaceID.String(), "episode_id", key.EpisodeID.String(),
			"participant_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(keyPair.listener.String()))), "publication_id_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(keyPair.publication))),
			"step", pair.step, "error_kind", pair.errorKind, "duration_ms", now.Sub(pair.since).Milliseconds()}})
	}
	if (overdue > 0 || state.truncated) && now.Sub(state.lastSummary) >= receiveHealthSummaryInterval {
		state.lastSummary = now
		events = append(events, receiveHealthEvent{"Episode audio publication pull health", []any{
			"event", "media.listener_publication_summary", "tenant_id", key.TenantID.String(), "space_id", key.SpaceID.String(), "episode_id", key.EpisodeID.String(),
			"no_pull_attempted_count", counts["no_pull_attempted"], "pull_failed_count", counts["pull_failed"], "pull_succeeded_count", counts["pull_succeeded"], "overdue_count", overdue, "truncated", state.truncated}})
	}
	return events
}

func (h *receiveHealth) warn(ctx context.Context, now time.Time) {
	h.mu.Lock()
	warn := h.lastWarning.IsZero() || now.Sub(h.lastWarning) >= receiveHealthSummaryInterval
	if warn {
		h.lastWarning = now
	}
	h.mu.Unlock()
	if warn {
		slog.WarnContext(ctx, "Audio pull health sampling is incomplete", "event", "media.listener_publication_sampling_incomplete")
	}
}
