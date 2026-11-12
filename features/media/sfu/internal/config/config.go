// Package config loads and bounds the SFU's configuration from the environment.
package config

import (
	_ "embed"
	"time"
)

// Config holds every tunable of the service. Load enforces the bounds.
type Config struct {
	// ControlAddr is the mutual-TLS control listener. It defaults to all
	// interfaces: the listener is public, and mutual TLS plus a firewall guard it.
	ControlAddr string
	// UDPAddr is the single UDP socket every WebRTC peer shares.
	UDPAddr string
	// TCPAddr is the TCP listener that carries media for a peer whose network blocks UDP (ICE-TCP).
	// Empty turns it off, and then such a peer can reach the node only through a TURN relay.
	TCPAddr string
	// AnnounceIPs are the addresses put into ICE candidates. Empty means the host's interfaces.
	AnnounceIPs []string
	// IncludeLoopback offers loopback ICE candidates. Only local runs and tests need it.
	IncludeLoopback bool
	// UDPReceiveBuffer is the SO_RCVBUF size requested for the UDP socket. The
	// kernel grants at most net.core.rmem_max, so the host must raise it too.
	UDPReceiveBuffer int
	// UDPSendBuffer is the SO_SNDBUF size requested for the UDP socket. The kernel grants at most
	// net.core.wmem_max, so the host must raise it too. A full send buffer drops outgoing media.
	UDPSendBuffer int

	TLSCertFile    string
	TLSKeyFile     string
	ClientCAFile   string
	ClientIdentity string

	// SourceLeaseTTL is how long a granted source forwards without a renewing grant.
	// The API renews every live grant well inside it, so lost control connectivity
	// stops forwarding at expiry instead of leaving an orphan publication running.
	SourceLeaseTTL time.Duration

	MaxSessions                int
	MaxPublishedPerSession     int
	MaxSubscriptionsPerSession int
	// MaxCapturesPerEpisode is the most capture sessions one Episode holds, such as a recording and a
	// transcription capture. 0 turns capture sessions off: the node refuses a capture create.
	MaxCapturesPerEpisode int
	// MaxCaptureSubscriptions is the most tracks one capture session pulls. A capture takes every
	// Participant's microphone and camera, so it needs more than a Participant's limit.
	MaxCaptureSubscriptions int
	MaxRequestBytes         int64
	// PacketBudget is the node's admission budget in packets/s, in plus out, set by the node size
	// (SFU_NODE_SIZE). A join that would push the Episodes' reservations above it is refused.
	PacketBudget int
	// VideoStreamCost is the reserved packets/s of one camera sent to one subscriber, at its top
	// layer. CameraUplinkCost is what the camera's publisher sends the node: every simulcast
	// layer, because publishers keep sending all of them. AudioStreamCost is one microphone's
	// packets/s per hop. The defaults come from the SDK's camera encodings (h 2.5 Mbit/s and
	// l 650 kbit/s at 30 frames/s, 1,150-byte payloads): a frame takes ceil(bytes/1150) packets,
	// so h sends 30·10 = 300 and l sends 30·3 = 90 packets/s, 390 on the uplink. Real SDK
	// cameras measured about 300 and 90.
	VideoStreamCost  int
	CameraUplinkCost int
	AudioStreamCost  int
	// CamerasPerParticipant is the most cameras one Participant publishes. Admission reserves
	// for that many, and a push of one more is refused.
	CamerasPerParticipant int
	// MaxEpisodeParticipants caps live sessions in one Episode. It is a safety bound, not the
	// admission rule: the packet budget refuses a large Episode first on today's node sizes.
	MaxEpisodeParticipants int
	// EpisodePacketCeiling is the most packets/s, ingress plus egress including repair, that one
	// Episode may use. The allocator lowers and pauses camera video to stay under it, so an
	// Episode reserves at most this much. Audio, the screen share and camera uplinks are never
	// lowered, so a join or screen share whose mandatory media cannot fit under it is refused.
	EpisodePacketCeiling int
	// LargeCallParticipants is the Episode size past which a subscriber is assumed to show
	// cameras as small tiles, which the SDK requests at the low layer. 0 turns that off. Past it
	// admission reserves SmallTileStreamCost, the low layer's packets/s to one subscriber, for
	// every camera but one featured Participant's, and the Episode's ceiling is the node budget.
	LargeCallParticipants int
	SmallTileStreamCost   int
	// ScreenStreamCost is the packets/s one hop of the screen share's video is assumed to need.
	// Screen video has no lower layer, so the allocator cannot reduce it.
	ScreenStreamCost int
	// Memory caps one ingress stream's retransmission history (one second at most) and one
	// subscriber's pacer queue.
	Memory Memory
	// Guard closes admission of new Episodes while the host cannot serve them on time.
	Guard Guard
	// Telemetry exports the node's metrics.
	Telemetry          Telemetry
	NegotiationTimeout time.Duration
	ConnectTimeout     time.Duration
	ShutdownTimeout    time.Duration
}

// Memory holds the per-stream byte caps of the design's memory budget.
type Memory struct {
	HistoryHighBytes   int // camera "h", or a camera without simulcast
	HistoryLowBytes    int // camera "l" and any lower layer
	HistoryScreenBytes int
	PacerQueueBytes    int
}

// Telemetry exports the node's metrics over OTLP/HTTP, the way the API does. The exporter reads
// its headers, which carry the token, from OTEL_EXPORTER_OTLP_METRICS_HEADERS.
type Telemetry struct {
	// OTLPEndpoint is the collector's base URL, without a path. Empty turns export off.
	OTLPEndpoint string
	// OTLPInsecure sends plain HTTP. Only a local environment may set it.
	OTLPInsecure bool
	// Environment is "local", "staging" or "production"; Version the source revision.
	Environment string
	Version     string
	// Interval is how often the node exports.
	Interval time.Duration
}

// Guard holds the host-health thresholds that close admission of new Episodes.
type Guard struct {
	// MaxStealPercent is the CPU steal, over Window, above which new Episodes are refused.
	MaxStealPercent float64
	// MaxBusyPercent is the host CPU time spent working, steal and idle excluded, over Window,
	// above which new Episodes are refused.
	MaxBusyPercent float64
	// MaxSchedulerLatency is the Go scheduler latency p99, over the last 10 seconds, above which
	// new Episodes are refused.
	MaxSchedulerLatency time.Duration
	// MaxPacerDropPercent is the share of video the pacers dropped for a full queue, over Window,
	// above which new Episodes are refused.
	MaxPacerDropPercent float64
	// MaxUDPErrorsPerSecond is the host's UDP datagrams dropped per second for a full receive or
	// send buffer, over Window, above which new Episodes are refused.
	MaxUDPErrorsPerSecond int
	Window                time.Duration
}
