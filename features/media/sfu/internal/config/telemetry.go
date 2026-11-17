package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"time"
)

// newIncarnation is 4 random bytes in hex.
func newIncarnation() string {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(buffer)
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
