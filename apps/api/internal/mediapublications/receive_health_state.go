package mediapublications

import (
	"crypto/sha256"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
		if !publication.Source.IsAudio() || len(publication.PublicationID) > 4096 {
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

func (h *receiveHealth) clear() {
	h.mu.Lock()
	defer h.mu.Unlock()
	clear(h.episodes)
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
