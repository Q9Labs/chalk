package media

import (
	"fmt"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// An Episode reserves its supported peak. Each Participant publishes one camera and one
// microphone and receives both from every other Participant, and one screen share with its audio
// runs. With a stream cost of c = video + audio per hop, n Participants need
//
//	n·c (uplinks) + n·(n-1)·c (downlinks) + c (screen uplink) + (n-1)·c (screen downlinks)
//	  = c·n·(n+1) packets/s.
//
// The allocator holds every Episode under its packet ceiling by lowering and pausing camera
// video, so an Episode reserves the lower of that peak and the ceiling. An Episode needs room for
// two Participants from its first join, so a lone Participant reserves what two would. A join is
// refused when it would push the sum above the node budget.
func (n *Node) episodeReservation(participants int) int {
	if participants <= 0 {
		return 0
	}
	return min(nominalReservation(participants, n.streamCost()), n.episodeCeiling())
}

// nominalReservation is c·n·(n+1) for at least two Participants, before the ceiling applies.
func nominalReservation(participants, streamCost int) int {
	count := max(participants, 2)
	return streamCost * count * (count + 1)
}

// episodeCeiling is the most packets/s one Episode may use: the configured ceiling, never more
// than the node's whole budget.
func (n *Node) episodeCeiling() int { return min(n.cfg.EpisodePacketCeiling, n.cfg.PacketBudget) }

// mandatoryPackets is the media the allocator can never lower: every microphone to every
// Participant, n·n audio hops, each camera's uplink, because the plan lowers only what
// subscribers receive, and the screen share's video and audio to all n when one runs.
func (n *Node) mandatoryPackets(participants int, screen bool) int {
	packets := n.cfg.AudioStreamCost*participants*participants + n.cfg.VideoStreamCost*participants
	if screen {
		packets += (n.cfg.ScreenStreamCost + n.cfg.AudioStreamCost) * participants
	}
	return packets
}

type episodeKey struct{ tenant, episode string }

func episodeOf(scope protocol.Scope) episodeKey { return episodeKey{scope.TenantID, scope.EpisodeID} }

func (n *Node) streamCost() int { return n.cfg.VideoStreamCost + n.cfg.AudioStreamCost }

// NewEpisodePackets is the reservation of an Episode's first join: room for two Participants.
func (n *Node) NewEpisodePackets() int { return n.episodeReservation(1) }

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
		total += n.episodeReservation(count)
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
	key := episodeOf(scope)
	count := counts[key]
	if count+1 > n.cfg.MaxEpisodeParticipants {
		return errEpisodeFull
	}
	// A replacement keeps its Participant's place, so only a new Episode meets the guard.
	if count == 0 && replacing == nil {
		if reason := n.guard.closedReason(); reason != "" {
			return fmt.Errorf("%w: %s", errAdmissionClosed, reason)
		}
	}
	if n.mandatoryPackets(count+1, n.screens[key] != nil) > n.episodeCeiling() {
		return errMandatoryMedia
	}
	grown := total - n.episodeReservation(count) + n.episodeReservation(count+1)
	if grown > n.cfg.PacketBudget {
		return errNodeFull
	}
	return nil
}
