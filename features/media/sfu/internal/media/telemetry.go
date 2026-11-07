package media

import "maps"

// Refusal reasons label the joins and screen shares the node refused. They are a closed set, so a
// metric can carry them as an attribute.
const (
	RefusedDraining         = "draining"
	RefusedSessions         = "sessions"
	RefusedFences           = "fences"
	RefusedEpisodeFull      = "episode_full"
	RefusedMandatoryMedia   = "mandatory_media"
	RefusedNodeFull         = "node_full"
	RefusedScreenCeiling    = "screen_ceiling"
	RefusedCameras          = "cameras"
	RefusedCPUSteal         = reasonCPUSteal
	RefusedCPUBusy          = reasonCPUBusy
	RefusedSchedulerLatency = reasonSchedulerLatency
	RefusedPacerDrops       = reasonPacerDrops
	RefusedUDPErrors        = reasonUDPBufferErrors
)

// Ingress kinds split what publishers send by media.
const (
	ingressAudio = iota
	ingressVideo
	ingressKinds
)

var ingressNames = [ingressKinds]string{"audio", "video"}

var classNames = [packetClasses]string{classAudio: "audio", classRepair: "repair", classVideo: "video", classProbe: "probe"}

// Telemetry is the node's state for metric export. It names no Tenant, Episode, Participant,
// session or address, only node-wide counts and closed sets of labels.
type Telemetry struct {
	Sessions, Episodes            int
	Draining                      bool
	PacketBudget, ReservedPackets int
	Health                        HostHealth
	// UDPReceiveErrors and UDPSendErrors are the host's counts of UDP datagrams dropped for a full
	// receive or send buffer, valid only where UDPErrorsKnown.
	UDPReceiveErrors, UDPSendErrors uint64
	UDPErrorsKnown                  bool
	// UDPSendRefused counts datagrams the kernel refused to send and UDPReceiveTruncated those
	// it cut short on receipt, both from the node's own batched socket.
	UDPSendRefused, UDPReceiveTruncated uint64
	// CongestionPaused counts video subscriptions a subscriber's own downlink pauses, and
	// PlannerPaused those an Episode plan pauses to hold its ceiling. CappedCameras and
	// PausedCameras are the cameras the Episode ceilings lower or pause.
	CongestionPaused, PlannerPaused, CappedCameras, PausedCameras int
	// In is what publishers send the node, by kind; Out is what the node sends subscribers, by
	// packet class. Each flow has its rate over the last second and its total since start.
	In, Out []Flow
	Totals  Totals
	// Refusals counts refused joins and screen shares by reason since start.
	Refusals map[string]uint64
}

// Flow is one direction and kind of media.
type Flow struct {
	Kind                            string
	PacketsPerSecond, BitsPerSecond float64
	Packets, Bytes                  uint64
}

// Totals are repair and forwarding counts since the node started.
type Totals struct {
	// PacerDrops is video the pacers dropped because a queue was full; RepairsCut the
	// retransmissions over a repair rate cap.
	PacerDrops, RepairsCut uint64
	// NACKRequested is the sequence numbers the node asked publishers to resend, retries included;
	// KeyframeRepairs the gaps it repaired with a keyframe instead.
	NACKRequested, KeyframeRepairs uint64
	// RTXReceived is the packets publishers resent as RTX repairs.
	RTXReceived uint64
	// LayerSwitches is the layer switches video subscriptions began, each one's first layer included.
	LayerSwitches uint64
}

// flowTotals are one flow's packets and bytes since start.
type flowTotals struct{ packets, bytes uint64 }

// nodeTotals are the node's counts since start. Packet loops only add to their own stream's
// counters; the control loop adds what every live stream grew by on each tick, so a stream that
// closes between ticks loses at most one tick of its counts.
type nodeTotals struct {
	in     [ingressKinds]flowTotals
	out    [packetClasses]flowTotals
	counts Totals
}

// counted is the part of a stream's cumulative count already added to the node's totals.
type counted uint64

// take returns how much total grew since the last take.
func (c *counted) take(total uint64) uint64 {
	grown := total - uint64(*c)
	*c = counted(total)
	return grown
}

// refuse counts a refused join or screen share, logs why and returns its error. The reason is
// a closed set and the log names no Tenant, Episode or Participant. The caller holds n.mu.
func (n *Node) refuse(reason string, err error) error {
	n.refusals[reason]++
	n.log.Warn("refused", "reason", reason, "sessions", len(n.sessions))
	return err
}

// Telemetry reports the node for metric export. It reads the control loop's latest tick, so it
// costs nothing on the packet path.
func (n *Node) Telemetry() Telemetry {
	n.mu.Lock()
	telemetry := Telemetry{
		Sessions: len(n.sessions), Draining: n.draining || n.stopped,
		PacketBudget: n.cfg.PacketBudget, ReservedPackets: n.reservedPackets(),
		Refusals: maps.Clone(n.refusals),
	}
	n.mu.Unlock()
	telemetry.Health = n.guard.snapshot()
	if errs, known := readUDPErrors(udpStatsPath); known {
		telemetry.UDPReceiveErrors, telemetry.UDPSendErrors, telemetry.UDPErrorsKnown = errs.receive, errs.send, true
	}

	if socket, ok := n.media.(interface {
		counters() (refused, truncated uint64)
	}); ok {
		telemetry.UDPSendRefused, telemetry.UDPReceiveTruncated = socket.counters()
	}

	stats := n.stats.Load()
	if stats == nil {
		stats = &mediaStats{}
	}
	telemetry.Episodes = len(stats.episodes)
	telemetry.CongestionPaused, telemetry.PlannerPaused = stats.congested, stats.plannerPaused
	for _, episode := range stats.episodes {
		telemetry.CappedCameras += episode.CappedCameras
		telemetry.PausedCameras += episode.PausedCameras
	}
	for kind := range ingressKinds {
		rate, total := stats.in[kind], stats.totals.in[kind]
		telemetry.In = append(telemetry.In, Flow{ingressNames[kind], rate.pps, rate.bps, total.packets, total.bytes})
	}
	for class := range packetClasses {
		rate, total := stats.out[class], stats.totals.out[class]
		telemetry.Out = append(telemetry.Out, Flow{classNames[class], rate.pps, rate.bps, total.packets, total.bytes})
	}
	telemetry.Totals = stats.totals.counts
	return telemetry
}

// tallyIngress samples one publisher layer and adds what it received since the last tick to the
// node's totals. Only the control loop calls it.
func (n *Node) tallyIngress(kind int, layer *ingressLayer, now int64) {
	packets, bytes := layer.meter.sample(now)
	n.totals.in[kind].packets += packets
	n.totals.in[kind].bytes += bytes
	n.totals.counts.RTXReceived += layer.tallied.repaired.take(layer.repaired.Load())
	if layer.nack != nil {
		n.totals.counts.NACKRequested += layer.tallied.requested.take(layer.nack.requested.Load())
		n.totals.counts.KeyframeRepairs += layer.tallied.abandoned.take(layer.nack.abandoned.Load())
	}
}

// tallyEgress adds what one subscriber transport sent and dropped since the last tick to the
// node's totals. Only the control loop calls it.
func (n *Node) tallyEgress(growth transportGrowth) {
	for class := range packetClasses {
		n.totals.out[class].packets += growth.packets[class]
		n.totals.out[class].bytes += growth.bytes[class]
	}
	n.totals.counts.PacerDrops += growth.dropped
	n.totals.counts.RepairsCut += growth.repairsCut
}

// layerTallies are the parts of an ingress layer's counters the node's totals already hold. Only
// the control loop touches them.
type layerTallies struct{ repaired, requested, abandoned counted }

// transportGrowth is what a subscriber transport sent and dropped since the previous tick.
type transportGrowth struct {
	packets, bytes      [packetClasses]uint64
	dropped, repairsCut uint64
}
