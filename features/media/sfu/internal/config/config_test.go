package config

import (
	"maps"
	"strings"
	"testing"
	"time"
)

func lookupOf(values map[string]string) Lookup {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

var required = map[string]string{
	"SFU_TLS_CERT_FILE":   "server.pem",
	"SFU_TLS_KEY_FILE":    "server.key",
	"SFU_CLIENT_CA_FILE":  "ca.pem",
	"SFU_CLIENT_IDENTITY": "api.chalk.internal",
}

func TestAdmissionDefaults(t *testing.T) {
	cfg, err := Load(lookupOf(required))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.VideoStreamCost != 300 || cfg.CameraUplinkCost != 390 || cfg.AudioStreamCost != 50 {
		t.Errorf("stream costs %d video, %d camera uplink and %d audio, want 300, 390 and 50", cfg.VideoStreamCost, cfg.CameraUplinkCost, cfg.AudioStreamCost)
	}
	if cfg.PacketBudget != 16000 {
		t.Errorf("packet budget %d, want 16000 for the smallest node", cfg.PacketBudget)
	}
	if cfg.MaxEpisodeParticipants != 16 {
		t.Errorf("Participant cap %d, want 16", cfg.MaxEpisodeParticipants)
	}
	if cfg.EpisodePacketCeiling != 11520 {
		t.Errorf("Episode ceiling %d, want 11520", cfg.EpisodePacketCeiling)
	}
	if cfg.LargeCallParticipants != 6 || cfg.SmallTileStreamCost != 90 {
		t.Errorf("large call past %d Participants at %d packets/s per small tile, want 6 and 90", cfg.LargeCallParticipants, cfg.SmallTileStreamCost)
	}
	want := Memory{HistoryHighBytes: 400 << 10, HistoryLowBytes: 128 << 10, HistoryScreenBytes: 320 << 10, PacerQueueBytes: 128 << 10}
	if cfg.Memory != want {
		t.Errorf("memory caps %+v, want the design's budget %+v", cfg.Memory, want)
	}
	if cfg.Guard.MaxStealPercent != 3 || cfg.Guard.MaxQueueDelay != 50*time.Millisecond || cfg.Guard.Window != 30*time.Second {
		t.Errorf("guard %+v, want 3%% steal or 50 ms queue delay over 30 s", cfg.Guard)
	}
}

// The camera costs are the packets/s of the SDK's simulcast encodings, from
// sdks/typescript/client/src/media/client.ts: h at 2.5 Mbit/s and l at 650 kbit/s, 30 frames/s.
// A frame takes ceil(bytes/1150) packets. Real cameras measured 300 and 90 on a deployed node.
func TestCameraCostsFollowTheSDKEncodings(t *testing.T) {
	const framesPerSecond, payloadBytes = 30, 1150
	packets := func(bitsPerSecond int) int {
		frameBytes := bitsPerSecond / 8 / framesPerSecond
		return framesPerSecond * ((frameBytes + payloadBytes - 1) / payloadBytes)
	}
	cfg, err := Load(lookupOf(required))
	if err != nil {
		t.Fatal(err)
	}
	high, low := packets(2_500_000), packets(650_000)
	if high != 300 || low != 90 {
		t.Fatalf("the encodings need %d and %d packets/s, want the measured 300 and 90", high, low)
	}
	if cfg.VideoStreamCost != high || cfg.CameraUplinkCost != high+low {
		t.Errorf("camera costs %d downlink and %d uplink, want %d and %d", cfg.VideoStreamCost, cfg.CameraUplinkCost, high, high+low)
	}
}

func TestGuardDefaults(t *testing.T) {
	cfg, err := Load(lookupOf(required))
	if err != nil {
		t.Fatal(err)
	}
	want := Guard{MaxStealPercent: 3, MaxBusyPercent: 90, MaxQueueDelay: 50 * time.Millisecond, MaxPacerDropPercent: 5, MaxUDPErrorsPerSecond: 5, Window: 30 * time.Second}
	if cfg.Guard != want {
		t.Errorf("guard %+v, want %+v", cfg.Guard, want)
	}
	if cfg.UDPSendBuffer != 8<<20 || cfg.UDPReceiveBuffer != 8<<20 {
		t.Errorf("socket buffers %d send and %d receive, want 8 MiB each", cfg.UDPSendBuffer, cfg.UDPReceiveBuffer)
	}
}

func TestAdmissionSettingsAreConfigurable(t *testing.T) {
	values := map[string]string{"SFU_PACKET_BUDGET": "32000", "SFU_MAX_EPISODE_PARTICIPANTS": "24"}
	for key, value := range required {
		values[key] = value
	}
	cfg, err := Load(lookupOf(values))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PacketBudget != 32000 || cfg.MaxEpisodeParticipants != 24 {
		t.Fatalf("budget %d and cap %d, want 32000 and 24", cfg.PacketBudget, cfg.MaxEpisodeParticipants)
	}
}

func TestLoadReportsEveryInvalidSetting(t *testing.T) {
	_, err := Load(lookupOf(map[string]string{"SFU_MAX_EPISODE_PARTICIPANTS": "0", "SFU_PACKET_BUDGET": "lots"}))
	if err == nil {
		t.Fatal("invalid settings loaded")
	}
	for _, key := range []string{"SFU_TLS_CERT_FILE", "SFU_CLIENT_IDENTITY", "SFU_MAX_EPISODE_PARTICIPANTS", "SFU_PACKET_BUDGET"} {
		if !strings.Contains(err.Error(), key) {
			t.Errorf("error %q does not name %s", err, key)
		}
	}
}

// A lease must outlast two of the API's 5 s renewal intervals, or it lapses between them.
func TestSourceLeaseOutlastsTwoRenewals(t *testing.T) {
	load := func(ttl string) (Config, error) {
		values := map[string]string{"SFU_SOURCE_LEASE_TTL": ttl}
		for key, value := range required {
			values[key] = value
		}
		return Load(lookupOf(values))
	}
	if _, err := load("9s"); err == nil || !strings.Contains(err.Error(), "SFU_SOURCE_LEASE_TTL") {
		t.Fatalf("a 9s lease loaded: %v", err)
	}
	if cfg, err := load("10s"); err != nil || cfg.SourceLeaseTTL != 10*time.Second {
		t.Fatalf("a 10s lease = %v, %v", cfg.SourceLeaseTTL, err)
	}
}

func TestTelemetrySettings(t *testing.T) {
	base := map[string]string{"SFU_TLS_CERT_FILE": "c", "SFU_TLS_KEY_FILE": "k", "SFU_CLIENT_CA_FILE": "ca", "SFU_CLIENT_IDENTITY": "id"}
	cases := []struct {
		name     string
		settings map[string]string
		problem  string // empty when the settings load
	}{
		{"off by default", nil, ""},
		{"https base URL", map[string]string{"SFU_OTLP_ENDPOINT": "https://otlp.example", "SFU_ENVIRONMENT": "production"}, ""},
		{"plain HTTP locally", map[string]string{"SFU_OTLP_ENDPOINT": "http://127.0.0.1:4318", "SFU_OTLP_INSECURE": "true"}, ""},
		{"plain HTTP in production", map[string]string{"SFU_OTLP_ENDPOINT": "http://otlp.example", "SFU_OTLP_INSECURE": "true", "SFU_ENVIRONMENT": "production"}, "SFU_OTLP_INSECURE"},
		{"http without insecure", map[string]string{"SFU_OTLP_ENDPOINT": "http://otlp.example"}, "must use https"},
		{"a path", map[string]string{"SFU_OTLP_ENDPOINT": "https://otlp.example/v1/metrics"}, "without a path"},
		{"insecure without endpoint", map[string]string{"SFU_OTLP_INSECURE": "true"}, "requires SFU_OTLP_ENDPOINT"},
		{"unknown environment", map[string]string{"SFU_ENVIRONMENT": "nightly"}, "SFU_ENVIRONMENT"},
		{"interval too short", map[string]string{"SFU_OTLP_INTERVAL": "100ms"}, "SFU_OTLP_INTERVAL"},
	}
	for _, c := range cases {
		settings := maps.Clone(base)
		maps.Copy(settings, c.settings)
		cfg, err := Load(lookupOf(settings))
		switch {
		case c.problem == "" && err != nil:
			t.Errorf("%s: %v", c.name, err)
		case c.problem != "" && (err == nil || !strings.Contains(err.Error(), c.problem)):
			t.Errorf("%s: error %v, want one naming %q", c.name, err, c.problem)
		case c.problem == "" && cfg.Telemetry.Interval != 10*time.Second:
			t.Errorf("%s: interval %v, want 10s", c.name, cfg.Telemetry.Interval)
		}
	}
}
