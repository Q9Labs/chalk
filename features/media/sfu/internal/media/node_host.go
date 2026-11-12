package media

import (
	"math"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// Budget reports the node's packet budget and the part live Episodes reserve.
func (n *Node) Budget() (budget, reserved int) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.cfg.PacketBudget, n.reservedPackets()
}

// Host reports the host-health guard and the node's measured media for readiness.
func (n *Node) Host() protocol.HostState {
	health := n.guard.snapshot()
	state := protocol.HostState{
		AdmissionReason:       health.AdmissionReason,
		QueueDelayP95Ms:       milliseconds(health.QueueDelayP95),
		SchedulerLatencyP99Ms: milliseconds(health.SchedulerLatencyP99),
		UDPReceiveBufferBytes: n.sockets.receiveBuffer,
		UDPSendBufferBytes:    n.sockets.sendBuffer,
	}
	state.Goroutines, state.HeapInuseBytes = readRuntime()
	if state.AdmissionReason == "" {
		n.mu.Lock()
		if n.retirementsFull() {
			state.AdmissionReason = reasonRetirementsFull
		}
		n.mu.Unlock()
	}
	if rss, known := ResidentBytes(); known {
		state.RSSBytes = &rss
	}
	if errs, known := readUDPErrors(udpStatsPath); known {
		state.UDPReceiveBufferErrors, state.UDPSendBufferErrors = &errs.receive, &errs.send
	}
	if health.StealKnown {
		steal := round2(health.StealPercent)
		state.StealPercent = &steal
	}
	if stats := n.stats.Load(); stats != nil {
		state.PacketsPerSecond = math.Round(stats.packets)
	}
	return state
}

// episodeState is the Episode's state as of the latest allocation.
func (n *Node) episodeState(key episodeKey) protocol.EpisodeState {
	if stats := n.stats.Load(); stats != nil {
		return stats.episodes[key]
	}
	return protocol.EpisodeState{}
}

func milliseconds(d time.Duration) float64 { return round2(float64(d) / float64(time.Millisecond)) }

// SessionCount is the number of live sessions.
func (n *Node) SessionCount() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.sessions)
}
