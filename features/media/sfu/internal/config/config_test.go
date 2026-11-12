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

// A call that admission accepts must fit the per-session subscription limits: 16 Participants
// with 2 cameras and a microphone each is 15·3 = 45 remote tracks, plus a screen share and its audio.
func TestSubscriptionLimitsFitTheAdmittedCallShape(t *testing.T) {
	load := func(extra map[string]string) (Config, error) {
		values := map[string]string{}
		for key, value := range required {
			values[key] = value
		}
		for key, value := range extra {
			values[key] = value
		}
		return Load(lookupOf(values))
	}
	cfg, err := load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxSubscriptionsPerSession != 47 || cfg.MaxCaptureSubscriptions != 64 {
		t.Errorf("defaults %d per session and %d per capture, want 47 and 64", cfg.MaxSubscriptionsPerSession, cfg.MaxCaptureSubscriptions)
	}
	cfg, err = load(map[string]string{"SFU_MAX_EPISODE_PARTICIPANTS": "32"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxSubscriptionsPerSession != 95 || cfg.MaxCaptureSubscriptions != 98 {
		t.Errorf("a 32-Participant node gets %d per session and %d per capture, want 95 and 98", cfg.MaxSubscriptionsPerSession, cfg.MaxCaptureSubscriptions)
	}
	if _, err := load(map[string]string{"SFU_MAX_SUBSCRIPTIONS_PER_SESSION": "32"}); err == nil || !strings.Contains(err.Error(), "SFU_MAX_SUBSCRIPTIONS_PER_SESSION") {
		t.Errorf("32 subscriptions for a 16-Participant call loaded: %v", err)
	}
	if _, err := load(map[string]string{"SFU_MAX_EPISODE_PARTICIPANTS": "12", "SFU_MAX_SUBSCRIPTIONS_PER_SESSION": "33"}); err == nil {
		t.Error("33 tracks leave no room for the screen share of a 12-Participant call")
	}
	if _, err := load(map[string]string{"SFU_MAX_EPISODE_PARTICIPANTS": "12", "SFU_MAX_SUBSCRIPTIONS_PER_SESSION": "35"}); err != nil {
		t.Errorf("35 subscriptions hold a 12-Participant call: %v", err)
	}
	if _, err := load(map[string]string{"SFU_MAX_CAPTURE_SUBSCRIPTIONS": "40"}); err == nil || !strings.Contains(err.Error(), "SFU_MAX_CAPTURE_SUBSCRIPTIONS") {
		t.Errorf("40 capture subscriptions loaded: %v", err)
	}
}
