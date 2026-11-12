package protocol

type InspectRequest struct {
	Scope Scope `json:"scope"`
	// Peer inspects a session of another Participant in the same Tenant and Episode,
	// as the API does to confirm that a publisher's track is really gone. The scope
	// is the caller's own; a session of another Tenant or Episode still reads as gone.
	Peer bool `json:"peer,omitempty"`
}

type InspectedTrack struct {
	Location  string `json:"location"`
	Mid       string `json:"mid"`
	TrackName string `json:"trackName"`
	SessionID string `json:"sessionId,omitempty"`
	Active    bool   `json:"active"`
	// Layers lists a local video track's ingress layers in RID order. A single
	// encoding is one layer with an empty RID.
	Layers []InspectedLayer `json:"layers,omitempty"`
	// Subscription is the delivery state of a remote track.
	Subscription *SubscriptionState `json:"subscription,omitempty"`
}

type InspectedLayer struct {
	RID    string `json:"rid"`
	Active bool   `json:"active"`
	// RequestedPackets counts the lost packets the node asked the publisher to
	// resend, and RepairedPackets the resends that arrived over RTX.
	RequestedPackets uint64 `json:"requestedPackets"`
	RepairedPackets  uint64 `json:"repairedPackets"`
}

// SubscriptionState is how a subscription is delivered. Revision rises on every
// change of State or Reason, so a reader keeps the highest one it has seen. It also
// rises when the source's grant opens a forwarding window and when that window ends
// by revoke or lapse, but not when a renewal extends it.
type SubscriptionState struct {
	State    string `json:"state"`
	Reason   string `json:"reason,omitempty"`
	Revision uint64 `json:"revision"`
	// RequestedRID is the subscriber's preferred layer. EffectiveRID
	// is the layer being forwarded, empty while paused or before the first keyframe.
	RequestedRID string `json:"requestedRid,omitempty"`
	EffectiveRID string `json:"effectiveRid,omitempty"`
}

// Subscription states and the reasons for a pause.
const (
	SubscriptionActive  = "active"
	SubscriptionPaused  = "paused"
	PauseCongestion     = "congestion"
	PauseViewer         = "viewer"
	PauseSourceInactive = "source_inactive"
	// PauseSourceUnauthorized: the source has no live grant. It was never granted,
	// was revoked, or its lease lapsed, so RTP that still arrives is not delivered.
	PauseSourceUnauthorized = "source_unauthorized"
)

type InspectResponse struct {
	Tracks []InspectedTrack `json:"tracks"`
	// Transport is how the node paces and estimates the session's downlink.
	Transport TransportState `json:"transport"`
	// Episode is the session's Episode against its packet ceiling.
	Episode EpisodeState `json:"episode"`
}

// TransportState is one session's downlink as the node's pacer and estimator
// see it. A subscriber that sends no transport-wide feedback is estimated by its
// receiver reports and REMB, and its feedback age is the age of the latest report.
type TransportState struct {
	EstimateBps int64 `json:"estimateBps"`
	// ProvenBps is what the downlink has shown it carries; layers rise only within it.
	ProvenBps int64 `json:"provenBps"`
	// FeedbackAgeMs is the age of the latest transport-wide feedback (or receiver report), absent before the first.
	FeedbackAgeMs *int64 `json:"feedbackAgeMs,omitempty"`
	QueuedBytes   int    `json:"queuedBytes"`
	Probing       bool   `json:"probing"`
	// Sent counts packets by class since the session opened.
	Sent        PacketCounts `json:"sent"`
	Dropped     uint64       `json:"dropped"`    // video the pacer dropped on a full queue
	RepairsCut  uint64       `json:"repairsCut"` // retransmissions over the repair rate cap
	Probes      uint64       `json:"probes"`
	ProvedProbe uint64       `json:"provedProbes"`
}

type PacketCounts struct {
	Audio  uint64 `json:"audio"`
	Video  uint64 `json:"video"`
	Repair uint64 `json:"repair"`
	Probe  uint64 `json:"probe"`
}

// EpisodeState is an Episode's measured media against its packet ceiling, as
// of the node's latest allocation.
type EpisodeState struct {
	// PacketsPerSecond counts ingress and egress, repairs and probes included.
	PacketsPerSecond float64 `json:"packetsPerSecond"`
	CeilingPackets   int     `json:"ceilingPackets"`
	// CappedCameras and PausedCameras are cameras the Episode's plan holds at
	// their lowest layer or pauses for every subscriber.
	CappedCameras int `json:"cappedCameras"`
	PausedCameras int `json:"pausedCameras"`
}

// WireProtocol is the request-body revision this build of the node decodes. The node decodes
// requests strictly, so a field it does not know is refused with 400 invalid_request. A caller
// that sends a newer field reads ReadyResponse.Protocol first and places nothing on a node below
// the revision the field needs. A node that predates the field reports none, which reads as 0.
//
//	1: the original bodies.
//	2: create, reserve, move and source-control bodies carry allocationGeneration. A body without
//	   it is still accepted, so an API that predates the field still places on a node of this revision.
//
// Raise it when a caller may send a field an older node refuses, and in the same change raise the
// caller's minimum.
const WireProtocol = 2

type ReadyResponse struct {
	// Protocol is WireProtocol. Absent on a node that predates the field.
	Protocol int `json:"protocol,omitempty"`
	// Revision is the source commit the node was built from, as set at deploy (SFU_VERSION).
	// It is "dev" on a local run.
	Revision        string `json:"revision,omitempty"`
	NodeIncarnation string `json:"nodeIncarnation"`
	Sessions        int    `json:"sessions"`
	// PacketBudget is the node's packets/s budget and ReservedPackets the part
	// that live Episodes reserve. Admission refuses a join that would exceed it.
	PacketBudget    int `json:"packetBudget"`
	ReservedPackets int `json:"reservedPackets"`
	// NewEpisodePackets is what a new Episode reserves at its first join. The API
	// places a new Episode only on a node with at least this much budget left.
	NewEpisodePackets int       `json:"newEpisodePackets"`
	Host              HostState `json:"host"`
	// SessionKinds lists the non-default session kinds this node creates, such as
	// "capture". A node that predates session kinds omits it.
	SessionKinds []string `json:"sessionKinds,omitempty"`
	DrainState
}

// DrainState is what a restart waits on. The drain and undrain requests answer with it and
// readiness carries it. A node restarts without interrupting a call once Allocations and
// CleanupDebt are both zero.
type DrainState struct {
	// Draining is true while the node refuses new Episodes. Calls already on it continue and
	// still take joins.
	Draining bool `json:"draining"`
	// Allocations counts what the node holds for live Episodes: its sessions, capture sessions
	// included. Source leases are not in it.
	Allocations int `json:"allocations"`
	// CleanupDebt counts closes that have begun and not finished.
	CleanupDebt int `json:"cleanupDebt"`
	// SourceLeases counts the source leases open now. It is informational: leases are soft state,
	// the API renews standing grants with no session on the node, and a restart drops them, so
	// they do not hold a restart.
	SourceLeases int `json:"sourceLeases"`
}

// HostState is the host-health guard's view over its window.
type HostState struct {
	// AdmissionReason names why new Episodes are refused, absent while they are
	// admitted: "cpu_steal", "cpu_busy", "scheduler_latency", "pacer_drops" or
	// "udp_buffer_errors". Existing Episodes continue.
	AdmissionReason string `json:"admissionReason,omitempty"`
	// StealPercent is absent where the host does not report steal.
	StealPercent *float64 `json:"stealPercent,omitempty"`
	// QueueDelayP95Ms is the pacer queue delay of every subscriber, mostly set by
	// each subscriber's own pace. It does not close admission.
	QueueDelayP95Ms float64 `json:"queueDelayP95Ms"`
	// SchedulerLatencyP99Ms is how long runnable goroutines waited for a CPU over
	// the last 10 seconds, the guard's signal of a host too slow to keep up.
	SchedulerLatencyP99Ms float64 `json:"schedulerLatencyP99Ms"`
	// PacketsPerSecond is every Episode's measured media on the node.
	PacketsPerSecond float64 `json:"packetsPerSecond"`
	// UDPReceiveBufferBytes is the media socket's receive buffer as the kernel
	// granted it, zero when unknown. Below the requested size, raise
	// net.core.rmem_max on the host.
	UDPReceiveBufferBytes int `json:"udpReceiveBufferBytes"`
	// UDPReceiveBufferErrors counts the host's UDP datagrams dropped because a
	// receive buffer was full, since boot (RcvbufErrors). It is absent where the
	// host does not report it. A rising count means media loss on ingress.
	UDPReceiveBufferErrors *uint64 `json:"udpReceiveBufferErrors,omitempty"`
	// UDPSendBufferBytes is the media socket's send buffer as the kernel granted
	// it, zero when unknown. Below the requested size, raise net.core.wmem_max
	// on the host.
	UDPSendBufferBytes int `json:"udpSendBufferBytes"`
	// UDPSendBufferErrors counts the host's UDP datagrams dropped because a send
	// buffer was full, since boot (SndbufErrors). It is absent where the host
	// does not report it. A rising count means media loss on egress.
	UDPSendBufferErrors *uint64 `json:"udpSendBufferErrors,omitempty"`
	// Goroutines and HeapInuseBytes are the Go runtime's live goroutines and in-use heap spans.
	// RSSBytes is the process's resident memory, absent where the host does not report it. A
	// sampler charts them over a soak; /debug/pprof on the control port says where they come from.
	Goroutines     int     `json:"goroutines"`
	HeapInuseBytes uint64  `json:"heapInuseBytes"`
	RSSBytes       *uint64 `json:"rssBytes,omitempty"`
}
