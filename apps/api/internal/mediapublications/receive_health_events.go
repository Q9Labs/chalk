package mediapublications

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type receiveHealthEvent struct {
	message string
	args    []any
}

func emitReceiveHealthEvents(ctx context.Context, events []receiveHealthEvent) {
	for _, event := range events {
		slog.WarnContext(ctx, event.message, event.args...)
	}
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
		if !publication.Source.IsAudio() || publication.PublicationID == "" || len(publication.PublicationID) > 4096 {
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
