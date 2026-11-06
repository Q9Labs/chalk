// Package config loads and bounds the SFU's configuration from the environment.
package config

import (
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
	MaxRequestBytes            int64
	// PacketBudget is the node's admission budget in packets/s, in plus out. Set it
	// per node size: 16000 on s-1vcpu-1gb, 32000 on s-2vcpu-2gb. A join that would
	// push the Episodes' reservations above it is refused.
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
	// MaxQueueDelay is the pacer queue delay p95, over Window, above which new Episodes are refused.
	MaxQueueDelay time.Duration
	// MaxPacerDropPercent is the share of video the pacers dropped for a full queue, over Window,
	// above which new Episodes are refused.
	MaxPacerDropPercent float64
	// MaxUDPErrorsPerSecond is the host's UDP datagrams dropped per second for a full receive or
	// send buffer, over Window, above which new Episodes are refused.
	MaxUDPErrorsPerSecond int
	Window                time.Duration
}

// Lookup reads one setting, like os.LookupEnv.
type Lookup func(key string) (string, bool)

// Load reads SFU_* settings. It reports every invalid setting at once.
// minSourceLeaseTTL is two of the API's 5 s lease renewal intervals
// (providerbridge.SourceLeaseRenewInterval), so a lease cannot lapse between renewals.
const minSourceLeaseTTL = 10 * time.Second

func Load(lookup Lookup) (Config, error) {
	r := reader{lookup: lookup}
	cfg := Config{
		ControlAddr:                r.text("SFU_CONTROL_ADDR", ":8443"),
		UDPAddr:                    r.text("SFU_UDP_ADDR", ":50000"),
		AnnounceIPs:                r.list("SFU_ANNOUNCE_IPS"),
		IncludeLoopback:            r.boolean("SFU_ICE_LOOPBACK", false),
		UDPReceiveBuffer:           r.integer("SFU_UDP_RECEIVE_BUFFER", 8<<20, 256<<10, 64<<20),
		UDPSendBuffer:              r.integer("SFU_UDP_SEND_BUFFER", 8<<20, 256<<10, 64<<20),
		TLSCertFile:                r.required("SFU_TLS_CERT_FILE"),
		TLSKeyFile:                 r.required("SFU_TLS_KEY_FILE"),
		ClientCAFile:               r.required("SFU_CLIENT_CA_FILE"),
		ClientIdentity:             r.required("SFU_CLIENT_IDENTITY"),
		SourceLeaseTTL:             r.duration("SFU_SOURCE_LEASE_TTL", 15*time.Second, minSourceLeaseTTL, 2*time.Minute),
		MaxSessions:                r.integer("SFU_MAX_SESSIONS", 64, 1, 1024),
		MaxPublishedPerSession:     r.integer("SFU_MAX_PUBLISHED_PER_SESSION", 8, 1, 32),
		MaxSubscriptionsPerSession: r.integer("SFU_MAX_SUBSCRIPTIONS_PER_SESSION", 32, 1, 128),
		MaxRequestBytes:            int64(r.integer("SFU_MAX_REQUEST_BYTES", 256<<10, 4<<10, 1<<20)),
		PacketBudget:               r.integer("SFU_PACKET_BUDGET", 16000, 1000, 1000000),
		VideoStreamCost:            r.integer("SFU_VIDEO_STREAM_COST", 300, 1, 10000),
		CameraUplinkCost:           r.integer("SFU_CAMERA_UPLINK_COST", 390, 1, 10000),
		CamerasPerParticipant:      r.integer("SFU_CAMERAS_PER_PARTICIPANT", 2, 1, 8),
		AudioStreamCost:            r.integer("SFU_AUDIO_STREAM_COST", 50, 1, 10000),
		MaxEpisodeParticipants:     r.integer("SFU_MAX_EPISODE_PARTICIPANTS", 16, 1, 64),
		EpisodePacketCeiling:       r.integer("SFU_EPISODE_PACKET_CEILING", 11520, 1000, 1000000),
		ScreenStreamCost:           r.integer("SFU_SCREEN_STREAM_COST", 210, 1, 10000),
		Memory: Memory{
			HistoryHighBytes:   r.integer("SFU_HISTORY_HIGH_BYTES", 400<<10, 16<<10, 4<<20),
			HistoryLowBytes:    r.integer("SFU_HISTORY_LOW_BYTES", 128<<10, 16<<10, 4<<20),
			HistoryScreenBytes: r.integer("SFU_HISTORY_SCREEN_BYTES", 320<<10, 16<<10, 4<<20),
			PacerQueueBytes:    r.integer("SFU_PACER_QUEUE_BYTES", 128<<10, 16<<10, 4<<20),
		},
		Guard: Guard{
			MaxStealPercent:       float64(r.integer("SFU_GUARD_MAX_STEAL_PERCENT", 3, 1, 100)),
			MaxBusyPercent:        float64(r.integer("SFU_GUARD_MAX_BUSY_PERCENT", 90, 1, 100)),
			MaxQueueDelay:         r.duration("SFU_GUARD_MAX_QUEUE_DELAY", 50*time.Millisecond, 5*time.Millisecond, 5*time.Second),
			MaxPacerDropPercent:   float64(r.integer("SFU_GUARD_MAX_PACER_DROP_PERCENT", 5, 1, 100)),
			MaxUDPErrorsPerSecond: r.integer("SFU_GUARD_MAX_UDP_ERRORS_PER_SECOND", 5, 1, 1000000),
			Window:                r.duration("SFU_GUARD_WINDOW", 30*time.Second, 5*time.Second, 10*time.Minute),
		},
		Telemetry: Telemetry{
			OTLPEndpoint: r.text("SFU_OTLP_ENDPOINT", ""),
			OTLPInsecure: r.boolean("SFU_OTLP_INSECURE", false),
			Environment:  r.text("SFU_ENVIRONMENT", "local"),
			Version:      r.text("SFU_VERSION", "dev"),
			Interval:     r.duration("SFU_OTLP_INTERVAL", 10*time.Second, time.Second, 5*time.Minute),
		},
		NegotiationTimeout: r.duration("SFU_NEGOTIATION_TIMEOUT", 10*time.Second, time.Second, time.Minute),
		ConnectTimeout:     r.duration("SFU_CONNECT_TIMEOUT", 60*time.Second, 5*time.Second, 10*time.Minute),
		ShutdownTimeout:    r.duration("SFU_SHUTDOWN_TIMEOUT", 15*time.Second, time.Second, time.Minute),
	}
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
