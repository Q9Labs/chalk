package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	APIDirectURL               = "CHALK_API_DIRECT_URL"
	ChalkSFUEnabled            = "CHALK_SFU_ENABLED"
	ChalkSFUCaptureEnabled     = "CHALK_SFU_CAPTURE_ENABLED"
	ChalkSFUColocatedCapture   = "CHALK_SFU_COLOCATED_CAPTURE"
	ChalkSFUColocatedGraceSecs = "CHALK_SFU_COLOCATED_CAPTURE_GRACE_SECONDS"
	ChalkSFUNodes              = "CHALK_SFU_NODES"
	ChalkSFUApplicationID      = "CHALK_SFU_APPLICATION_ID"
	ChalkSFUServerName         = "CHALK_SFU_SERVER_NAME"
	ChalkSFUCAFile             = "CHALK_SFU_CA_FILE"
	ChalkSFUClientCertFile     = "CHALK_SFU_CLIENT_CERT_FILE"
	ChalkSFUClientKeyFile      = "CHALK_SFU_CLIENT_KEY_FILE"
	ChalkSFUTimeoutMS          = "CHALK_SFU_TIMEOUT_MS"
	ChalkSFUSTUNURLs           = "CHALK_SFU_STUN_URLS"
	ChalkSFUStandbyBudget      = "CHALK_SFU_STANDBY_PACKET_BUDGET"
	ChalkSFUNewEpisodes        = "CHALK_SFU_NEW_EPISODES"
	DefaultChalkSFUTimeoutMS   = int64(6000)
	// DefaultChalkSFUColocatedGraceSeconds is how long a capture waits for the healthy worker
	// beside its SFU node before an on-demand fleet worker may take it.
	DefaultChalkSFUColocatedGraceSeconds = int32(20)
	// DefaultChalkSFUStandbyBudget is the packets/s a standby admits for new
	// Episodes: half the primary's 32,000, because a standby is a smaller node.
	DefaultChalkSFUStandbyBudget = 16000
)

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

// ChalkSFUConfig points the API at the Chalk SFU. It is off by default: while
// Enabled is false the API does not issue media grants.
type ChalkSFUConfig struct {
	Enabled bool
	// CaptureEnabled lets the recorder reach the pool's nodes through the capture plane. It is
	// off by default and needs Enabled. Starting a recording on the Chalk SFU stays refused until
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

	// DirectSignalingURL is the origin of the direct door (TLS proxy on the host) for the
	// signalling routes. Each Chalk SFU join advertises it as directSignalingUrl, so the SDK
	// can skip the Tunnel and fall back to the regular API URL. Empty turns it off for new
	// joins without a web deploy. CHALK_API_DIRECT_URL.
	DirectSignalingURL string

	// NewEpisodesPaused is the deploy-time floor of the kill switch, CHALK_SFU_NEW_EPISODES=off.
	// New Episodes are refused, and Episodes already on the Chalk SFU keep
	// running there. Turning the Chalk SFU off instead would also strand those live Episodes.
	// The live switch (media-settings new-episodes) pauses on top of this floor, with no restart.
	NewEpisodesPaused bool
	RequestTimeout    time.Duration
}

// LoadNewEpisodesPaused reads the kill switch. It is on unless set to off.
func LoadNewEpisodesPaused() (bool, error) {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(ChalkSFUNewEpisodes)))
	switch value {
	case "", "on", "true":
		return false, nil
	case "off", "false":
		return true, nil
	default:
		return false, fmt.Errorf("%s must be on or off", ChalkSFUNewEpisodes)
	}
}

func loadChalkSFUConfig() (ChalkSFUConfig, error) {
	if !envBool(ChalkSFUEnabled) {
		return ChalkSFUConfig{}, nil
	}
	timeout, err := envMilliseconds(ChalkSFUTimeoutMS, DefaultChalkSFUTimeoutMS)
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	if timeout <= 0 {
		return ChalkSFUConfig{}, fmt.Errorf("%s must be greater than zero", ChalkSFUTimeoutMS)
	}
	standbyBudget, err := envInt32(ChalkSFUStandbyBudget, DefaultChalkSFUStandbyBudget)
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	if standbyBudget <= 0 {
		return ChalkSFUConfig{}, fmt.Errorf("%s must be greater than zero", ChalkSFUStandbyBudget)
	}
	directURL, err := directSignalingURL(os.Getenv(APIDirectURL))
	if err != nil {
		return ChalkSFUConfig{}, err
	}
	newEpisodesPaused, err := LoadNewEpisodesPaused()
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
		DirectSignalingURL:    directURL,
		CaptureEnabled:        envBool(ChalkSFUCaptureEnabled),
		ApplicationID:         strings.TrimSpace(envOrDefault(ChalkSFUApplicationID, "")),
		ServerName:            strings.TrimSpace(envOrDefault(ChalkSFUServerName, "")),
		CAFile:                strings.TrimSpace(envOrDefault(ChalkSFUCAFile, "")),
		ClientCertFile:        strings.TrimSpace(envOrDefault(ChalkSFUClientCertFile, "")),
		ClientKeyFile:         strings.TrimSpace(envOrDefault(ChalkSFUClientKeyFile, "")),
		STUNURLs:              envList(ChalkSFUSTUNURLs),
		RequestTimeout:        timeout,
	}
	config.StandbyPacketBudget = int(standbyBudget)
	if err := loadChalkSFUDeployment(&config); err != nil {
		return ChalkSFUConfig{}, err
	}
	return config, nil
}

func loadChalkSFUDeployment(config *ChalkSFUConfig) error {
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
	nodes, err := parseChalkSFUNodes(envList(ChalkSFUNodes))
	if err != nil {
		return err
	}
	config.Nodes = nodes
	return nil
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
