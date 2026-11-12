package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

// ChalkSFURole says whether placement prefers a node. A primary takes new
// Episodes in configuration order; a standby takes one only when no primary can.
type ChalkSFURole string

const (
	ChalkSFURolePrimary ChalkSFURole = "primary"
	ChalkSFURoleStandby ChalkSFURole = "standby"
)

// ChalkSFUNode is one SFU node. ID is the stable name Episode bindings record;
// ControlURL may change when the node's host changes. An empty Role is a primary.
type ChalkSFUNode struct {
	ID         string
	ControlURL string
	Role       ChalkSFURole
}

// ChalkSFUConfig points the API at Chalk's own SFU. It is off by default: while
// Enabled is false the Space selector refuses chalk_sfu and no adapter exists.
type ChalkSFUConfig struct {
	Enabled bool
	// CaptureEnabled lets the recorder reach the pool's nodes through the capture plane. It is
	// off by default and needs Enabled. Starting a recording on the own SFU stays refused until
	// the milestone's last step removes that check.
	CaptureEnabled bool
	// ColocatedCaptureGrace turns on the capture worker that runs beside each node. Zero is off,
	// and then every capture goes to the on-demand fleet. A capture waits this long for the
	// healthy worker of its node, then the fleet may take it. It needs CaptureEnabled.
	ColocatedCaptureGrace time.Duration
	// ApplicationID names the SFU pool and goes into each Episode binding, so it
	// stays the same when hosts or certificates rotate.
	ApplicationID string
	// Nodes are the SFU nodes of the pool in placement order. A new Episode goes to
	// the first ready primary with budget left for it, and to a standby only when no
	// primary can take it. Its binding names the node, so adding a node needs no
	// migration and never moves a live Episode.
	Nodes          []ChalkSFUNode
	ServerName     string
	CAFile         string
	ClientCertFile string
	ClientKeyFile  string
	STUNURLs       []string

	// StandbyPacketBudget caps the packets/s a standby admits for new Episodes, below
	// what the node itself reports. The node enforces its own budget as well.
	StandbyPacketBudget int

	// AllowedSpaces are the only Spaces that start Episodes on the own SFU while the
	// rest of the deployment stays on Cloudflare. It is empty by default, even when
	// Enabled is true. CHALK_SFU_ALLOWED_SPACES lists Space IDs, or * for all.
	AllowedSpaces spaces.ChalkSFUAllowlist

	// ClientSunset is the instant after which a client that does not declare the own
	// SFU can no longer start an Episode in a Space on the allowlist: it gets
	// media.client_unsupported instead of Cloudflare. The zero value means never.
	// CHALK_SFU_CLIENT_SUNSET is an RFC 3339 instant.
	ClientSunset time.Time

	// UnifiedSignaling advertises the single-URL signalling route in each own-SFU join, so the
	// SDK sends every signalling call to one URL and pays one CORS preflight. It is on by
	// default. Turning it off sends clients back to the per-operation routes without a web
	// deploy. CHALK_SFU_UNIFIED_SIGNALING.
	UnifiedSignaling bool

	// DirectSignalingURL is the origin of the direct door (TLS proxy on the host) for the
	// signalling routes. Each own-SFU join advertises it as directSignalingUrl, so the SDK
	// can skip the Tunnel and fall back to the regular API URL. Empty turns it off for new
	// joins without a web deploy. CHALK_API_DIRECT_URL.
	DirectSignalingURL string

	// NewEpisodesPaused is the deploy-time floor of the kill switch, CHALK_SFU_NEW_EPISODES=off.
	// Every new Episode then starts on Cloudflare, and Episodes already on the own SFU keep
	// running there. Turning the own SFU off instead would also strand those live Episodes.
	// The live switch (media-settings new-episodes) pauses on top of this floor, with no restart.
	NewEpisodesPaused bool

	// CloudflareOverflow lets a new Episode start on Cloudflare when no node has
	// room. It is on by default. When it is off, creating that Episode fails with
	// a retryable capacity error instead. Migration policy until M13 removes it.
	CloudflareOverflow bool
	RequestTimeout     time.Duration
}

func loadChalkSFUConfig() (ChalkSFUConfig, error) {
	if !envBool(ChalkSFUEnabled) {
		return ChalkSFUConfig{}, nil
	}
	timeout, err := envPositiveMilliseconds(ChalkSFUTimeoutMS, DefaultChalkSFUTimeoutMS)
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	overflow, err := envStrictBool(ChalkSFUCloudflareOverflow, true)
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	standbyBudget, err := envInt32(ChalkSFUStandbyBudget, DefaultChalkSFUStandbyBudget)
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	if standbyBudget <= 0 {
		return ChalkSFUConfig{}, fmt.Errorf("%s must be greater than zero", ChalkSFUStandbyBudget)
	}
	unifiedSignaling, err := envStrictBool(ChalkSFUUnifiedSignaling, true)
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	directURL, err := directSignalingURL(os.Getenv(APIDirectURL))
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	newEpisodesPaused, err := loadNewEpisodesPaused()
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	colocatedGrace, err := loadColocatedCaptureGrace()
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	config := ChalkSFUConfig{
		ColocatedCaptureGrace: colocatedGrace,
		Enabled:               true,
		NewEpisodesPaused:     newEpisodesPaused,
		UnifiedSignaling:      unifiedSignaling,
		DirectSignalingURL:    directURL,
		CaptureEnabled:        envBool(ChalkSFUCaptureEnabled),
		CloudflareOverflow:    overflow,
		ApplicationID:         strings.TrimSpace(envOrDefault(ChalkSFUApplicationID, "")),
		ServerName:            strings.TrimSpace(envOrDefault(ChalkSFUServerName, "")),
		CAFile:                strings.TrimSpace(envOrDefault(ChalkSFUCAFile, "")),
		ClientCertFile:        strings.TrimSpace(envOrDefault(ChalkSFUClientCertFile, "")),
		ClientKeyFile:         strings.TrimSpace(envOrDefault(ChalkSFUClientKeyFile, "")),
		STUNURLs:              envList(ChalkSFUSTUNURLs),
		RequestTimeout:        timeout,
	}
	if err := config.requireSettings(); err != nil {
		return ChalkSFUConfig{}, err
	}
	config.StandbyPacketBudget = int(standbyBudget)
	if err := config.loadPlacement(); err != nil {
		return ChalkSFUConfig{}, err
	}
	return config, nil
}

func loadColocatedCaptureGrace() (time.Duration, error) {
	if !envBool(ChalkSFUColocatedCapture) {
		return 0, nil
	}
	if !envBool(ChalkSFUCaptureEnabled) {
		return 0, fmt.Errorf("%s needs %s=true", ChalkSFUColocatedCapture, ChalkSFUCaptureEnabled)
	}
	seconds, err := envInt32(ChalkSFUColocatedGraceSecs, DefaultChalkSFUColocatedGraceSeconds)
	if err != nil {
		return 0, err
	}
	if seconds <= 0 {
		return 0, fmt.Errorf("%s must be greater than zero", ChalkSFUColocatedGraceSecs)
	}
	return time.Duration(seconds) * time.Second, nil
}

// parseChalkSFUNodes reads "id=https://host:port" and "standby:id=https://host:port"
// entries; an entry without a role prefix is a primary. IDs must be unique and
// valid binding node names, and every URL absolute https without query or fragment.
func parseChalkSFUNodes(entries []string) ([]ChalkSFUNode, error) {
	nodes := make([]ChalkSFUNode, 0, len(entries))
	seen := map[string]bool{}
	for _, entry := range entries {
		id, controlURL, found := strings.Cut(entry, "=")
		id, controlURL = strings.TrimSpace(id), strings.TrimSpace(controlURL)
		role := ChalkSFURolePrimary
		if prefix, rest, hasRole := strings.Cut(id, ":"); hasRole {
			if ChalkSFURole(prefix) != ChalkSFURoleStandby && ChalkSFURole(prefix) != ChalkSFURolePrimary {
				return nil, fmt.Errorf("%s entry %q has role %q, want primary or standby", ChalkSFUNodes, entry, prefix)
			}
			role, id = ChalkSFURole(prefix), rest
		}
		if !found || !mediaplane.ValidNodeID(id) {
			return nil, fmt.Errorf("%s entry %q must be id=https://host:port with a lowercase id", ChalkSFUNodes, entry)
		}
		if seen[id] {
			return nil, fmt.Errorf("%s names node %q twice", ChalkSFUNodes, id)
		}
		seen[id] = true
		parsed, err := url.Parse(controlURL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("%s node %q must have an absolute https URL without query or fragment", ChalkSFUNodes, id)
		}
		nodes = append(nodes, ChalkSFUNode{ID: id, ControlURL: controlURL, Role: role})
	}
	return nodes, nil
}

// directSignalingURL accepts empty (off) or an https origin: the SDK appends the route path to it.
func directSignalingURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%s must be an https origin without a path", APIDirectURL)
	}
	return "https://" + u.Host, nil
}

// requireSettings fails when a setting an enabled fleet cannot run without is empty.
func (config ChalkSFUConfig) requireSettings() error {
	required := []struct{ name, value string }{
		{ChalkSFUApplicationID, config.ApplicationID},
		{ChalkSFUNodes, strings.TrimSpace(envOrDefault(ChalkSFUNodes, ""))},
		{ChalkSFUServerName, config.ServerName},
		{ChalkSFUCAFile, config.CAFile},
		{ChalkSFUClientCertFile, config.ClientCertFile},
		{ChalkSFUClientKeyFile, config.ClientKeyFile},
	}
	for _, field := range required {
		if field.value == "" {
			return fmt.Errorf("%s must be set when %s is on", field.name, ChalkSFUEnabled)
		}
	}
	return nil
}

// loadPlacement reads the nodes, the Space allowlist and the client sunset.
func (config *ChalkSFUConfig) loadPlacement() error {
	var err error
	if config.Nodes, err = parseChalkSFUNodes(envList(ChalkSFUNodes)); err != nil {
		return err
	}
	if config.AllowedSpaces, err = spaces.ParseChalkSFUAllowlist(envList(ChalkSFUAllowedSpaces)); err != nil {
		return fmt.Errorf("%s: %w", ChalkSFUAllowedSpaces, err)
	}
	if sunset := strings.TrimSpace(envOrDefault(ChalkSFUClientSunset, "")); sunset != "" {
		if config.ClientSunset, err = time.Parse(time.RFC3339, sunset); err != nil {
			return fmt.Errorf("%s must be an RFC 3339 instant: %w", ChalkSFUClientSunset, err)
		}
	}
	return nil
}
