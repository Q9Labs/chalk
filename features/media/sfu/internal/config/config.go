// Package config loads and bounds the SFU's configuration from the environment.
package config

import (
	"errors"
	"fmt"
	"net"
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

	TLSCertFile    string
	TLSKeyFile     string
	ClientCAFile   string
	ClientIdentity string

	MaxSessions                int
	MaxPublishedPerSession     int
	MaxSubscriptionsPerSession int
	MaxRequestBytes            int64
	NegotiationTimeout         time.Duration
	ConnectTimeout             time.Duration
	ShutdownTimeout            time.Duration
}

// Lookup reads one setting, like os.LookupEnv.
type Lookup func(key string) (string, bool)

// Load reads SFU_* settings. It reports every invalid setting at once.
func Load(lookup Lookup) (Config, error) {
	r := reader{lookup: lookup}
	cfg := Config{
		ControlAddr:                r.text("SFU_CONTROL_ADDR", ":8443"),
		UDPAddr:                    r.text("SFU_UDP_ADDR", ":50000"),
		AnnounceIPs:                r.list("SFU_ANNOUNCE_IPS"),
		IncludeLoopback:            r.boolean("SFU_ICE_LOOPBACK", false),
		TLSCertFile:                r.required("SFU_TLS_CERT_FILE"),
		TLSKeyFile:                 r.required("SFU_TLS_KEY_FILE"),
		ClientCAFile:               r.required("SFU_CLIENT_CA_FILE"),
		ClientIdentity:             r.required("SFU_CLIENT_IDENTITY"),
		MaxSessions:                r.integer("SFU_MAX_SESSIONS", 64, 1, 1024),
		MaxPublishedPerSession:     r.integer("SFU_MAX_PUBLISHED_PER_SESSION", 8, 1, 32),
		MaxSubscriptionsPerSession: r.integer("SFU_MAX_SUBSCRIPTIONS_PER_SESSION", 32, 1, 128),
		MaxRequestBytes:            int64(r.integer("SFU_MAX_REQUEST_BYTES", 256<<10, 4<<10, 1<<20)),
		NegotiationTimeout:         r.duration("SFU_NEGOTIATION_TIMEOUT", 10*time.Second, time.Second, time.Minute),
		ConnectTimeout:             r.duration("SFU_CONNECT_TIMEOUT", 60*time.Second, 5*time.Second, 10*time.Minute),
		ShutdownTimeout:            r.duration("SFU_SHUTDOWN_TIMEOUT", 15*time.Second, time.Second, time.Minute),
	}
	for _, ip := range cfg.AnnounceIPs {
		if net.ParseIP(ip) == nil {
			r.fail("SFU_ANNOUNCE_IPS", fmt.Errorf("%q is not an IP address", ip))
		}
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
