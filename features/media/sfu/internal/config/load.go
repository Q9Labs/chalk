package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"time"
)

// Lookup reads one setting, like os.LookupEnv.
type Lookup func(key string) (string, bool)

// minSourceLeaseTTL is two of the API's 5 s lease renewal intervals
// (providerbridge.SourceLeaseRenewInterval), so a lease cannot lapse between renewals.
const minSourceLeaseTTL = 10 * time.Second

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
		SourceLeaseTTL:             r.duration("SFU_SOURCE_LEASE_TTL", 15*time.Second, minSourceLeaseTTL, 2*time.Minute),
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
		Memory:                     r.memory(),
		Guard:                      r.guard(stealPercent),
		Telemetry:                  r.telemetry(environment),
		NegotiationTimeout:         r.duration("SFU_NEGOTIATION_TIMEOUT", 10*time.Second, time.Second, time.Minute),
		ConnectTimeout:             r.duration("SFU_CONNECT_TIMEOUT", 60*time.Second, 5*time.Second, 10*time.Minute),
		ShutdownTimeout:            r.duration("SFU_SHUTDOWN_TIMEOUT", 15*time.Second, time.Second, time.Minute),
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

func (r *reader) memory() Memory {
	return Memory{
		HistoryHighBytes:   r.integer("SFU_HISTORY_HIGH_BYTES", 400<<10, 16<<10, 4<<20),
		HistoryLowBytes:    r.integer("SFU_HISTORY_LOW_BYTES", 128<<10, 16<<10, 4<<20),
		HistoryScreenBytes: r.integer("SFU_HISTORY_SCREEN_BYTES", 320<<10, 16<<10, 4<<20),
		PacerQueueBytes:    r.integer("SFU_PACER_QUEUE_BYTES", 128<<10, 16<<10, 4<<20),
	}
}

func (r *reader) guard(stealPercent int) Guard {
	return Guard{
		MaxStealPercent:       float64(r.integer("SFU_GUARD_MAX_STEAL_PERCENT", stealPercent, 1, 100)),
		MaxBusyPercent:        float64(r.integer("SFU_GUARD_MAX_BUSY_PERCENT", 90, 1, 100)),
		MaxSchedulerLatency:   r.duration("SFU_GUARD_MAX_SCHEDULER_LATENCY", 20*time.Millisecond, time.Millisecond, 5*time.Second),
		MaxPacerDropPercent:   float64(r.integer("SFU_GUARD_MAX_PACER_DROP_PERCENT", 5, 1, 100)),
		MaxUDPErrorsPerSecond: r.integer("SFU_GUARD_MAX_UDP_ERRORS_PER_SECOND", 5, 1, 1000000),
		Window:                r.duration("SFU_GUARD_WINDOW", 30*time.Second, 5*time.Second, 10*time.Minute),
	}
}

func (r *reader) telemetry(environment string) Telemetry {
	return Telemetry{
		OTLPEndpoint: r.text("SFU_OTLP_ENDPOINT", ""),
		OTLPInsecure: r.boolean("SFU_OTLP_INSECURE", false),
		Environment:  environment,
		Version:      r.text("SFU_VERSION", "dev"),
		Interval:     r.duration("SFU_OTLP_INTERVAL", 10*time.Second, time.Second, 5*time.Minute),
	}
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
