package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func placementLogs(t *testing.T, provider mediaplane.Provider, reason mediaplane.PlacementReason) []map[string]any {
	t.Helper()
	var out bytes.Buffer
	telemetry := NewMediaPlaneResolutionTelemetry(slog.New(slog.NewJSONHandler(&out, nil)))
	telemetry.RecordPlacement(context.Background(), provider, reason)
	var lines []map[string]any
	for _, raw := range bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n")) {
		if len(raw) == 0 {
			continue
		}
		var line map[string]any
		if err := json.Unmarshal(raw, &line); err != nil {
			t.Fatalf("log line is not JSON: %v", err)
		}
		lines = append(lines, line)
	}
	return lines
}

func TestRecordPlacementLogsEveryOverflowWithAStableEvent(t *testing.T) {
	cases := []struct {
		name     string
		provider mediaplane.Provider
		reason   mediaplane.PlacementReason
	}{
		{"moved to Cloudflare, no room", mediaplane.ProviderCloudflareSFU, mediaplane.PlacementOverflowNoRoom},
		{"moved to Cloudflare, host guard", mediaplane.ProviderCloudflareSFU, mediaplane.PlacementOverflowHostGuard},
		{"refused, draining", mediaplane.ProviderChalkSFU, mediaplane.PlacementOverflowDraining},
		{"moved to Cloudflare, node unavailable", mediaplane.ProviderCloudflareSFU, mediaplane.PlacementOverflowNodeUnavailable},
		{"moved to Cloudflare, node too old", mediaplane.ProviderCloudflareSFU, mediaplane.PlacementOverflowNodeProtocol},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lines := placementLogs(t, tc.provider, tc.reason)
			if len(lines) != 1 {
				t.Fatalf("got %d log lines, want 1", len(lines))
			}
			line := lines[0]
			if line["event"] != "chalk_sfu.overflow" || line["level"] != "WARN" {
				t.Fatalf("event %v level %v, want chalk_sfu.overflow at WARN", line["event"], line["level"])
			}
			if line["provider"] != tc.provider.SettingName() || line["placement_reason"] != string(tc.reason) {
				t.Fatalf("provider %v reason %v, want %s %s", line["provider"], line["placement_reason"], tc.provider, tc.reason)
			}
			for key := range line {
				switch key {
				case "time", "level", "msg", "event", "provider", "placement_reason":
				default:
					t.Fatalf("unexpected field %q: an overflow line carries no Tenant, Episode or node identity", key)
				}
			}
		})
	}
}

func TestRecordPlacementLogsNothingForAPlacementOnANode(t *testing.T) {
	for _, reason := range []mediaplane.PlacementReason{mediaplane.PlacementPrimary, mediaplane.PlacementStandby, mediaplane.PlacementNoCapacity} {
		if lines := placementLogs(t, mediaplane.ProviderChalkSFU, reason); len(lines) != 0 {
			t.Fatalf("reason %s logged %d lines, want none", reason, len(lines))
		}
	}
}
