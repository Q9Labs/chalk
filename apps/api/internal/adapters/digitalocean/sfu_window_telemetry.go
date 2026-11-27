package digitalocean

import (
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

//go:embed sfu_window_telemetry.sh
var sfuWindowTelemetryScript string

// SFUWindowTelemetry is the Axiom OTLP endpoint and ingest headers a window node exports with. The snapshot
// holds no ingest token, so Create sends these in the Droplet's user data. Either header may be empty.
type SFUWindowTelemetry struct {
	Endpoint       string
	MetricsHeaders string
	LogsHeaders    string
}

func (t SFUWindowTelemetry) enabled() bool {
	return t.Endpoint != "" && (t.MetricsHeaders != "" || t.LogsHeaders != "")
}

func (t SFUWindowTelemetry) validate() error {
	if !t.enabled() {
		if t.Endpoint == "" && t.MetricsHeaders == "" && t.LogsHeaders == "" {
			return nil
		}
		return errors.New("window telemetry needs an endpoint and at least one header")
	}
	parsed, err := url.Parse(t.Endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || strings.ContainsAny(t.Endpoint, "|&\\\n\r\"' $") {
		return errors.New("window telemetry endpoint must be a plain https URL")
	}
	for name, value := range map[string]string{"metrics": t.MetricsHeaders, "logs": t.LogsHeaders} {
		if strings.ContainsAny(value, "\n\r\x00") || len(value) > 2048 {
			return fmt.Errorf("window telemetry %s headers must be one line of at most 2048 bytes", name)
		}
	}
	return nil
}

// userData renders the cloud-config that installs the telemetry, or "" when export is off.
func (t SFUWindowTelemetry) userData() string {
	if !t.enabled() {
		return ""
	}
	var out strings.Builder
	out.WriteString("#cloud-config\nwrite_files:\n")
	for _, file := range []struct{ name, mode, content string }{
		{"endpoint", "0600", t.Endpoint}, {"metrics-headers", "0600", t.MetricsHeaders},
		{"log-headers", "0600", t.LogsHeaders}, {"install", "0700", sfuWindowTelemetryScript},
	} {
		if file.content == "" {
			continue
		}
		fmt.Fprintf(&out, "  - path: /run/chalk-window-telemetry/%s\n    permissions: '%s'\n    encoding: b64\n    content: %s\n", file.name, file.mode, base64.StdEncoding.EncodeToString([]byte(file.content)))
	}
	out.WriteString("runcmd:\n  - [/bin/bash, /run/chalk-window-telemetry/install]\n")
	return out.String()
}
