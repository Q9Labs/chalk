package digitalocean

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func windowTelemetry() SFUWindowTelemetry {
	return SFUWindowTelemetry{Endpoint: "https://api.axiom.co", MetricsHeaders: "Authorization=Bearer%20m,X-Axiom-Dataset=metrics", LogsHeaders: "Authorization=Bearer%20l,X-Axiom-Dataset=logs"}
}

func TestCreateSendsTelemetryAsUserDataWhenConfigured(t *testing.T) {
	fake := newFakeDigitalOcean(t, routes(nil, []map[string]any{goodFirewall()}))
	telemetry := windowTelemetry()
	if _, err := fake.adapter(func(c *SFUWindowConfig) { c.Telemetry = telemetry }).Create(context.Background(), testWindowName); err != nil {
		t.Fatalf("Create: %v", err)
	}
	var body struct {
		UserData string `json:"user_data"`
	}
	if err := json.Unmarshal([]byte(fake.requests[2].Body), &body); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(body.UserData, "#cloud-config\nwrite_files:\n") || !strings.HasSuffix(body.UserData, "runcmd:\n  - [/bin/bash, /run/chalk-window-telemetry/install]\n") {
		t.Fatalf("user data = %q", body.UserData)
	}
	for _, want := range []string{"/endpoint", "/metrics-headers", "/log-headers", "/install"} {
		if !strings.Contains(body.UserData, "path: /run/chalk-window-telemetry"+want) {
			t.Fatalf("user data lacks %s", want)
		}
	}
	for _, secret := range []string{telemetry.MetricsHeaders, telemetry.LogsHeaders} {
		if !strings.Contains(body.UserData, base64.StdEncoding.EncodeToString([]byte(secret))) {
			t.Fatalf("user data lacks an encoded header")
		}
	}
	if body.UserData != telemetry.userData() {
		t.Fatal("user data is not deterministic")
	}
}

func TestTelemetryWithoutHeadersOrEndpointIsRefused(t *testing.T) {
	for name, telemetry := range map[string]SFUWindowTelemetry{
		"headers without endpoint": {MetricsHeaders: "a=b"},
		"endpoint without headers": {Endpoint: "https://api.axiom.co"},
		"plain http":               {Endpoint: "http://api.axiom.co", LogsHeaders: "a=b"},
		"shell metacharacter":      {Endpoint: "https://api.axiom.co/|x", LogsHeaders: "a=b"},
		"multiline headers":        {Endpoint: "https://api.axiom.co", LogsHeaders: "a=b\nc=d"},
	} {
		fake := newFakeDigitalOcean(t, routes(nil, nil))
		config := SFUWindowConfig{
			Token: testWindowToken, BaseURL: fake.server.URL, OwnerTag: testWindowOwnerTag, FirewallTag: testWindowFirewallTag, FirewallID: testWindowFirewallID,
			SnapshotID: testWindowSnapshot, Region: testWindowRegion, VPCUUID: testWindowVPC, Telemetry: telemetry,
		}
		if _, err := NewSFUWindow(config); !errors.Is(err, ErrSFUWindowInvalid) {
			t.Errorf("%s: err = %v, want ErrSFUWindowInvalid", name, err)
		}
	}
}
