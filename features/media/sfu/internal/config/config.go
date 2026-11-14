// Package config loads and bounds the SFU's configuration from the environment.
package config

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
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
	// The default outlasts an API restart or deploy (see defaultSourceLeaseTTL).
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

// nodes is the table of node sizes, ports and guard limits. The deploy scripts and the OpenTofu
// module read the same file, so a node is described once. A size's packet budget admits only as many
// classes as keep the node's own CPU under about 65% of what its vCPUs deliver at the worst steal
// seen (52% over 10 s): a 3-person, 2-camera class reserves 7170 packets/s and costs about 11% of
// one vCPU, so 22000 admits 3 classes on 1 vCPU and 36000 admits 5 on 2 (docs/sfu/capacity-calibration.md).
// Production closes admission to new Episodes at 40% steal; the other environments keep 25 so the
// guard stays easy to exercise there.
//
//go:embed node.json
var nodesJSON []byte

type nodeTable struct {
	Ports struct {
		Control int `json:"control"`
		Media   int `json:"media"`
	} `json:"ports"`
	DefaultSize string `json:"defaultSize"`
	Sizes       map[string]struct {
		PacketBudget int `json:"packetBudget"`
	} `json:"sizes"`
	StealPercent struct {
		Production int `json:"production"`
		Other      int `json:"other"`
	} `json:"stealPercent"`
}

var nodes = func() nodeTable {
	var table nodeTable
	if err := json.Unmarshal(nodesJSON, &table); err != nil {
		panic(fmt.Sprintf("node.json: %v", err))
	}
	return table
}()

// Lookup reads one setting, like os.LookupEnv.
type Lookup func(key string) (string, bool)

// minSourceLeaseTTL is two of the API's 5 s lease renewal intervals
// (providerbridge.SourceLeaseRenewInterval), so a lease cannot lapse between renewals.
const minSourceLeaseTTL = 10 * time.Second

// defaultSourceLeaseTTL is the grace the media has when the API cannot renew. In the staging
// recovery run an API outage of 84 s stopped a call's media for 39 s, because the 15 s lease ran
// out 15 s in. A stop the node never heard of (the control path was cut at that moment) keeps
// forwarding for at most this long; a stop the node did hear of takes effect at once.
const defaultSourceLeaseTTL = time.Minute

// Load reads SFU_* settings. It reports every invalid setting at once.
func Load(lookup Lookup) (Config, error) {
	r := reader{lookup: lookup}
	size := r.text("SFU_NODE_SIZE", nodes.DefaultSize)
	node, known := nodes.Sizes[size]
	if !known {
		r.fail("SFU_NODE_SIZE", fmt.Errorf("%q is not a node size in node.json", size))
	}
	environment := r.text("SFU_ENVIRONMENT", "local")
	stealPercent := nodes.StealPercent.Other
	if environment == "production" {
		stealPercent = nodes.StealPercent.Production
	}
	cfg := Config{
		ControlAddr:                r.text("SFU_CONTROL_ADDR", fmt.Sprintf(":%d", nodes.Ports.Control)),
		UDPAddr:                    r.text("SFU_UDP_ADDR", fmt.Sprintf(":%d", nodes.Ports.Media)),
		TCPAddr:                    r.text("SFU_TCP_ADDR", ""),
		AnnounceIPs:                r.list("SFU_ANNOUNCE_IPS"),
		IncludeLoopback:            r.boolean("SFU_ICE_LOOPBACK", false),
		UDPReceiveBuffer:           r.integer("SFU_UDP_RECEIVE_BUFFER", 8<<20, 256<<10, 64<<20),
		UDPSendBuffer:              r.integer("SFU_UDP_SEND_BUFFER", 8<<20, 256<<10, 64<<20),
		TLSCertFile:                r.required("SFU_TLS_CERT_FILE"),
		TLSKeyFile:                 r.required("SFU_TLS_KEY_FILE"),
		ClientCAFile:               r.required("SFU_CLIENT_CA_FILE"),
		ClientIdentity:             r.required("SFU_CLIENT_IDENTITY"),
		SourceLeaseTTL:             r.duration("SFU_SOURCE_LEASE_TTL", defaultSourceLeaseTTL, minSourceLeaseTTL, 2*time.Minute),
		MaxSessions:                r.integer("SFU_MAX_SESSIONS", 64, 1, 1024),
		MaxPublishedPerSession:     r.integer("SFU_MAX_PUBLISHED_PER_SESSION", 8, 1, 32),
		MaxSubscriptionsPerSession: r.integer("SFU_MAX_SUBSCRIPTIONS_PER_SESSION", 0, 1, 512),
		MaxCapturesPerEpisode:      r.integer("SFU_MAX_CAPTURES_PER_EPISODE", 2, 0, 8),
		MaxCaptureSubscriptions:    r.integer("SFU_MAX_CAPTURE_SUBSCRIPTIONS", 0, 1, 512),
		MaxRequestBytes:            int64(r.integer("SFU_MAX_REQUEST_BYTES", 384<<10, 4<<10, 1<<20)),
		PacketBudget:               r.integer("SFU_PACKET_BUDGET", node.PacketBudget, 1000, 1000000),
		VideoStreamCost:            r.integer("SFU_VIDEO_STREAM_COST", 300, 1, 10000),
		CameraUplinkCost:           r.integer("SFU_CAMERA_UPLINK_COST", 390, 1, 10000),
		CamerasPerParticipant:      r.integer("SFU_CAMERAS_PER_PARTICIPANT", 2, 1, 8),
		AudioStreamCost:            r.integer("SFU_AUDIO_STREAM_COST", 50, 1, 10000),
		MaxEpisodeParticipants:     r.integer("SFU_MAX_EPISODE_PARTICIPANTS", 16, 1, 64),
		EpisodePacketCeiling:       r.integer("SFU_EPISODE_PACKET_CEILING", 11520, 1000, 1000000),
		LargeCallParticipants:      r.integer("SFU_LARGE_CALL_PARTICIPANTS", 6, 0, 64),
		SmallTileStreamCost:        r.integer("SFU_SMALL_TILE_STREAM_COST", 90, 1, 10000),
		ScreenStreamCost:           r.integer("SFU_SCREEN_STREAM_COST", 210, 1, 10000),
		Memory: Memory{
			HistoryHighBytes:   r.integer("SFU_HISTORY_HIGH_BYTES", 400<<10, 16<<10, 4<<20),
			HistoryLowBytes:    r.integer("SFU_HISTORY_LOW_BYTES", 128<<10, 16<<10, 4<<20),
			HistoryScreenBytes: r.integer("SFU_HISTORY_SCREEN_BYTES", 320<<10, 16<<10, 4<<20),
			PacerQueueBytes:    r.integer("SFU_PACER_QUEUE_BYTES", 128<<10, 16<<10, 4<<20),
		},
		Guard: Guard{
			MaxStealPercent:       float64(r.integer("SFU_GUARD_MAX_STEAL_PERCENT", stealPercent, 1, 100)),
			MaxBusyPercent:        float64(r.integer("SFU_GUARD_MAX_BUSY_PERCENT", 90, 1, 100)),
			MaxSchedulerLatency:   r.duration("SFU_GUARD_MAX_SCHEDULER_LATENCY", 20*time.Millisecond, time.Millisecond, 5*time.Second),
			MaxPacerDropPercent:   float64(r.integer("SFU_GUARD_MAX_PACER_DROP_PERCENT", 5, 1, 100)),
			MaxUDPErrorsPerSecond: r.integer("SFU_GUARD_MAX_UDP_ERRORS_PER_SECOND", 5, 1, 1000000),
			Window:                r.duration("SFU_GUARD_WINDOW", 30*time.Second, 5*time.Second, 10*time.Minute),
		},
		Telemetry: Telemetry{
			OTLPEndpoint: r.text("SFU_OTLP_ENDPOINT", ""),
			OTLPInsecure: r.boolean("SFU_OTLP_INSECURE", false),
			Environment:  environment,
			Version:      r.text("SFU_VERSION", "dev"),
			Interval:     r.duration("SFU_OTLP_INTERVAL", 10*time.Second, time.Second, 5*time.Minute),
		},
		NegotiationTimeout: r.duration("SFU_NEGOTIATION_TIMEOUT", 10*time.Second, time.Second, time.Minute),
		ConnectTimeout:     r.duration("SFU_CONNECT_TIMEOUT", 60*time.Second, 5*time.Second, 10*time.Minute),
		ShutdownTimeout:    r.duration("SFU_SHUTDOWN_TIMEOUT", 15*time.Second, time.Second, time.Minute),
	}
	r.callShapeLimits(&cfg)
	for _, ip := range cfg.AnnounceIPs {
		if net.ParseIP(ip) == nil {
			r.fail("SFU_ANNOUNCE_IPS", fmt.Errorf("%q is not an IP address", ip))
		}
	}
	if err := validateTelemetry(cfg.Telemetry); err != nil {
		r.errs = append(r.errs, err)
	}
	if err := errors.Join(r.errs...); err != nil {
		return Config{}, fmt.Errorf("invalid SFU configuration: %w", err)
	}
	return cfg, nil
}

// remoteTracksOf is the most tracks one session receives from a call of n sessions that
// publish `cameras` cameras and a microphone each, plus a screen share and its audio.
// A capture is not a session, so it receives every one of the n.
func remoteTracksOf(n, cameras int) int { return n*(cameras+1) + 2 }

// callShapeLimits sets the per-session subscription limits from the call shape the node admits
// (SFU_MAX_EPISODE_PARTICIPANTS Participants with SFU_CAMERAS_PER_PARTICIPANT cameras each), and
// refuses an explicit limit that would turn a call that admission accepted into silent
// subscription failures. A 16-Participant call with 2 cameras needs 47 tracks per session.
func (r *reader) callShapeLimits(cfg *Config) {
	member := remoteTracksOf(cfg.MaxEpisodeParticipants-1, cfg.CamerasPerParticipant)
	capture := remoteTracksOf(cfg.MaxEpisodeParticipants, cfg.CamerasPerParticipant)
	if cfg.MaxSubscriptionsPerSession == 0 {
		cfg.MaxSubscriptionsPerSession = member
	} else if cfg.MaxSubscriptionsPerSession < member {
		r.fail("SFU_MAX_SUBSCRIPTIONS_PER_SESSION", fmt.Errorf("%d cannot hold a call of %d Participants with %d cameras each, which needs %d; raise it or lower SFU_MAX_EPISODE_PARTICIPANTS or SFU_CAMERAS_PER_PARTICIPANT", cfg.MaxSubscriptionsPerSession, cfg.MaxEpisodeParticipants, cfg.CamerasPerParticipant, member))
	}
	if cfg.MaxCaptureSubscriptions == 0 {
		cfg.MaxCaptureSubscriptions = max(capture, 64)
	} else if cfg.MaxCaptureSubscriptions < capture {
		r.fail("SFU_MAX_CAPTURE_SUBSCRIPTIONS", fmt.Errorf("%d cannot hold a capture of %d Participants with %d cameras each, which needs %d", cfg.MaxCaptureSubscriptions, cfg.MaxEpisodeParticipants, cfg.CamerasPerParticipant, capture))
	}
}

type reader struct {
	lookup Lookup
	errs   []error
}

func (r *reader) fail(key string, err error) {
	r.errs = append(r.errs, fmt.Errorf("%s: %w", key, err))
}

func (r *reader) text(key, fallback string) string {
	if value, ok := r.lookup(key); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func (r *reader) required(key string) string {
	value := r.text(key, "")
	if value == "" {
		r.fail(key, errors.New("is required"))
	}
	return value
}

func (r *reader) list(key string) []string {
	value := r.text(key, "")
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	for index := range parts {
		parts[index] = strings.TrimSpace(parts[index])
	}
	return parts
}

func (r *reader) boolean(key string, fallback bool) bool {
	value := r.text(key, "")
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		r.fail(key, err)
		return fallback
	}
	return parsed
}

func (r *reader) integer(key string, fallback, minimum, maximum int) int {
	value := r.text(key, "")
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		r.fail(key, fmt.Errorf("must be an integer from %d to %d", minimum, maximum))
		return fallback
	}
	return parsed
}

func (r *reader) duration(key string, fallback, minimum, maximum time.Duration) time.Duration {
	value := r.text(key, "")
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed < minimum || parsed > maximum {
		r.fail(key, fmt.Errorf("must be a duration from %s to %s", minimum, maximum))
		return fallback
	}
	return parsed
}

func validateTelemetry(t Telemetry) error {
	switch t.Environment {
	case "local", "staging", "production":
	default:
		return errors.New(`SFU_ENVIRONMENT: must be "local", "staging" or "production"`)
	}
	if t.OTLPEndpoint == "" {
		if t.OTLPInsecure {
			return errors.New("SFU_OTLP_INSECURE: requires SFU_OTLP_ENDPOINT")
		}
		return nil
	}
	if t.OTLPInsecure && t.Environment != "local" {
		return errors.New("SFU_OTLP_INSECURE: only a local environment may send plain HTTP")
	}
	endpoint, err := url.Parse(t.OTLPEndpoint)
	if err != nil || endpoint.Host == "" || endpoint.Path != "" && endpoint.Path != "/" || endpoint.RawQuery != "" {
		return errors.New("SFU_OTLP_ENDPOINT: must be an absolute base URL without a path")
	}
	want := "https"
	if t.OTLPInsecure {
		want = "http"
	}
	if endpoint.Scheme != want {
		return fmt.Errorf("SFU_OTLP_ENDPOINT: must use %s", want)
	}
	return nil
}
