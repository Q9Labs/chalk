package media

import "github.com/q9labs/chalk/features/media/sfu/protocol"

// An Episode reserves its supported peak. Each Participant publishes one camera and one
// microphone and receives both from every other Participant, and one screen share with its audio
// runs. With a stream cost of c = video + audio per hop, n Participants reserve
//
//	n·c (uplinks) + n·(n-1)·c (downlinks) + c (screen uplink) + (n-1)·c (screen downlinks)
//	  = c·n·(n+1) packets/s.
//
// An Episode needs room for two Participants from its first join, so a lone Participant
// reserves what two would. A join is refused when it would push the sum above the node budget.
func episodeReservation(participants int, streamCost int) int {
	if participants <= 0 {
		return 0
	}
	n := max(participants, 2)
	return streamCost * n * (n + 1)
}

type episodeKey struct{ tenant, episode string }

func episodeOf(scope protocol.Scope) episodeKey { return episodeKey{scope.TenantID, scope.EpisodeID} }

func (n *Node) streamCost() int { return n.cfg.VideoStreamCost + n.cfg.AudioStreamCost }

// NewEpisodePackets is the reservation of an Episode's first join: room for two Participants.
func (n *Node) NewEpisodePackets() int { return episodeReservation(1, n.streamCost()) }

// reservations counts live sessions per Episode, leaving out one session that is about to be
// replaced, and sums the Episodes' reservations. The caller holds n.mu.
func (n *Node) reservations(leaving *Session) (counts map[episodeKey]int, total int) {
	counts = map[episodeKey]int{}
	for _, session := range n.sessions {
		if session != leaving {
			counts[episodeOf(session.scope)]++
		}
	}
	for _, count := range counts {
		total += episodeReservation(count, n.streamCost())
	}
	return counts, total
}

// reservedPackets is the sum of every live Episode's reservation. The caller holds n.mu.
func (n *Node) reservedPackets() int {
	_, total := n.reservations(nil)
	return total
}

// admit checks that one more Participant fits in its Episode and on the node. replacing is the
// older generation of the same Participant that the new session replaces, if any, so a
// reconnect does not count twice. The caller holds n.mu.
func (n *Node) admit(scope protocol.Scope, replacing *Session) error {
	counts, total := n.reservations(replacing)
	count := counts[episodeOf(scope)]
	if count+1 > n.cfg.MaxEpisodeParticipants {
		return errEpisodeFull
	}
	grown := total - episodeReservation(count, n.streamCost()) + episodeReservation(count+1, n.streamCost())
	if grown > n.cfg.PacketBudget {
		return errNodeFull
	}
	return nil
}
