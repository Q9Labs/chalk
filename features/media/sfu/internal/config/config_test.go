package config

import (
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
	if cfg.VideoStreamCost != 150 || cfg.AudioStreamCost != 50 {
		t.Errorf("stream costs %d video and %d audio, want 150 and 50", cfg.VideoStreamCost, cfg.AudioStreamCost)
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
	want := Memory{HistoryHighBytes: 400 << 10, HistoryLowBytes: 128 << 10, HistoryScreenBytes: 320 << 10, PacerQueueBytes: 128 << 10}
	if cfg.Memory != want {
		t.Errorf("memory caps %+v, want the design's budget %+v", cfg.Memory, want)
	}
	if cfg.Guard.MaxStealPercent != 3 || cfg.Guard.MaxQueueDelay != 50*time.Millisecond || cfg.Guard.Window != 30*time.Second {
		t.Errorf("guard %+v, want 3%% steal or 50 ms queue delay over 30 s", cfg.Guard)
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
