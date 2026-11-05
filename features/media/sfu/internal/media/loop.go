package media

import (
	"math"
	"time"
)

const (
	// allocationInterval is how often every subscriber's layers are reallocated
	// from its bandwidth estimate and its Episode's packet ceiling.
	allocationInterval = 100 * time.Millisecond
	// guardInterval is how often the host-health guard samples.
	guardInterval = time.Second
	// telemetryInterval is how often the node logs one line of media telemetry.
	telemetryInterval = 10 * time.Second
)

// run is the node's control loop: it allocates layers and samples host health
// until the node closes.
func (n *Node) run() {
	allocate := time.NewTicker(allocationInterval)
	defer allocate.Stop()
	health := time.NewTicker(guardInterval)
	defer health.Stop()
	telemetry := time.NewTicker(telemetryInterval)
	defer telemetry.Stop()
	for {
		select {
		case <-n.done:
			return
		case <-allocate.C:
			n.allocate()
		case <-health.C:
			n.guard.tick()
		case <-telemetry.C:
			n.logTelemetry()
		}
	}
}

// logTelemetry writes one bounded line of node-wide media state. It names no
// Tenant, Episode, Participant or address, so it is safe to export.
func (n *Node) logTelemetry() {
	stats := n.stats.Load()
	if stats == nil {
		return
	}
	host := n.Host()
	capped, paused := 0, 0
	for _, episode := range stats.episodes {
		capped += episode.CappedCameras
		paused += episode.PausedCameras
	}
	attributes := []any{
		"sessions", n.SessionCount(), "episodes", len(stats.episodes),
		"packetsPerSecond", math.Round(stats.packets), "repairPerSecond", math.Round(stats.repair),
		"probePerSecond", math.Round(stats.probe), "congestionPaused", stats.congested,
		"cappedCameras", capped, "pausedCameras", paused,
		"queueDelayP95Ms", host.QueueDelayP95Ms, "schedulerLatencyP99Ms", host.SchedulerLatencyP99Ms,
		"admissionReason", host.AdmissionReason,
	}
	if host.StealPercent != nil {
		attributes = append(attributes, "stealPercent", *host.StealPercent)
	}
	n.log.Info("media telemetry", attributes...)
}
