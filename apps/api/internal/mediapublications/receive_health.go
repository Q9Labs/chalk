package mediapublications

import (
	"context"
	"errors"
	"time"

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
	receiveHealthMaxPublications = provideroperations.MaxPublications
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
