package digitalocean

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// SFUWindowSize is the only droplet size a window node may use.
const SFUWindowSize = "s-2vcpu-2gb"

const (
	sfuWindowNamePrefix = "window-sfu-"
	sfuWindowMaxPages   = 5
)

var (
	// ErrSFUWindowInvalid means a configuration value or call argument was
	// rejected before any request was sent.
	ErrSFUWindowInvalid = errors.New("sfu window: invalid configuration or argument")
	// ErrSFUWindowProvider means DigitalOcean was unreachable or answered with an
	// unusable status, body, or page link.
	ErrSFUWindowProvider = errors.New("sfu window: DigitalOcean request failed")
	// ErrSFUWindowDrift means a droplet carrying the node name is not an exact
	// window node: wrong owner tags, size, region, VPC, image, address, or case.
	ErrSFUWindowDrift = errors.New("sfu window: droplet does not match the owned window node shape")
	// ErrSFUWindowDuplicate means more than one droplet answers to the node name.
	ErrSFUWindowDuplicate = errors.New("sfu window: more than one droplet has the node name")
	// ErrSFUWindowExists means Create found the node already present and sent nothing.
	ErrSFUWindowExists = errors.New("sfu window: node already exists")
	// ErrSFUWindowFirewall means the pre-created firewall does not exclusively
	// target the window tags, so Create sent nothing.
	ErrSFUWindowFirewall = errors.New("sfu window: firewall does not agree with the window tags")
	// ErrSFUWindowCreateUnknown marks a Create failure where DigitalOcean may
	// have accepted the request. The droplet may exist, so the caller
	// must settle the outcome with Observe or Inspect and must not treat it as a rejection.
	ErrSFUWindowCreateUnknown = errors.New("sfu window: create outcome unknown")
)

// SFUWindowRateLimitError carries the earliest time DigitalOcean allows another request.
type SFUWindowRateLimitError struct{ RetryAt time.Time }

func (err *SFUWindowRateLimitError) Error() string { return "sfu window: DigitalOcean rate limited" }

// SFUWindowConfig scopes the adapter to one environment's window nodes.
//
// The snapshot must be ready to boot: release preloaded, environment-specific
// node TLS certificate baked in, no secrets in the image. The only user data is
// the optional Telemetry (Axiom ingest headers, write-only), which turns metric
// and log export on. The adapter sends no SSH keys, and nothing deploys over SSH
// at runtime. OwnerTag is the immutable environment owner tag and must be used by
// nothing else (standbys and static nodes carry their own). FirewallID must be
// the only firewall that targets OwnerTag or FirewallTag.
type SFUWindowConfig struct {
	Token       string
	BaseURL     string
	HTTPClient  *http.Client
	OwnerTag    string
	FirewallTag string
	FirewallID  string
	SnapshotID  int64
	Region      string
	VPCUUID     string
	Telemetry   SFUWindowTelemetry
}

// SFUWindowDroplet is the trusted view of one owned window node. Address is the
// droplet's single public IPv4 address, parsed rather than echoed. Active is
// true only once DigitalOcean reports the droplet active and it has that address.
type SFUWindowDroplet struct {
	ID       int64
	Address  netip.Addr
	Active   bool
	Outdated bool
}

// SFUWindow creates, observes, and destroys temporary SFU droplets.
//
// Create is for the lifecycle controller only, after it has journaled the
// attempt. Nothing here retries a request.
type SFUWindow struct {
	baseURL     *url.URL
	client      *http.Client
	token       string
	ownerTag    string
	firewallTag string
	firewallID  string
	snapshotID  int64
	region      string
	vpcUUID     string
	telemetry   SFUWindowTelemetry
	createMu    sync.Mutex
	retryAt     atomic.Int64
}

func NewSFUWindow(config SFUWindowConfig) (*SFUWindow, error) {
	baseURL, err := parseSFUWindowBaseURL(config.BaseURL)
	if err != nil {
		return nil, ErrSFUWindowInvalid
	}
	if !validSFUWindowTags(config) || !validSFUWindowNetwork(config) || !validSFUWindowToken(config.Token) {
		return nil, ErrSFUWindowInvalid
	}
	if err := config.Telemetry.validate(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrSFUWindowInvalid, err)
	}
	return &SFUWindow{
		baseURL: baseURL, client: newSFUWindowHTTPClient(config.HTTPClient), token: config.Token,
		ownerTag: config.OwnerTag, firewallTag: config.FirewallTag, firewallID: config.FirewallID,
		snapshotID: config.SnapshotID, region: config.Region, vpcUUID: config.VPCUUID,
		telemetry: config.Telemetry,
	}, nil
}

func parseSFUWindowBaseURL(raw string) (*url.URL, error) {
	if raw == "" {
		raw = defaultBaseURL
	}
	baseURL, err := url.Parse(raw)
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.Path != "" && baseURL.Path != "/" {
		return nil, ErrSFUWindowInvalid
	}
	return baseURL, nil
}

func validSFUWindowTags(config SFUWindowConfig) bool {
	return validDigitalOceanTag(config.OwnerTag) && validDigitalOceanTag(config.FirewallTag) && config.OwnerTag != config.FirewallTag
}

func validSFUWindowNetwork(config SFUWindowConfig) bool {
	return canonicalUUID(config.FirewallID) && canonicalUUID(config.VPCUUID) && config.SnapshotID > 0 && validRegionSlug(config.Region)
}

func validSFUWindowToken(token string) bool {
	return strings.TrimSpace(token) != "" && len(token) <= 4096
}

func newSFUWindowHTTPClient(configured *http.Client) *http.Client {
	client := &http.Client{Timeout: 15 * time.Second}
	if configured != nil {
		copied := *configured
		client = &copied
		if client.Timeout == 0 {
			client.Timeout = 15 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client
}

// Observe reads the single droplet whose name is exactly name. Any droplet that
// answers to the name, owned or not, must be the exact window node or the call
// fails closed, and two such droplets are always an error.
func (a *SFUWindow) Observe(ctx context.Context, name string) (SFUWindowDroplet, bool, error) {
	if !validSFUWindowName(name) {
		return SFUWindowDroplet{}, false, ErrSFUWindowInvalid
	}
	droplets, err := a.dropletsNamed(ctx, name)
	if err != nil {
		return SFUWindowDroplet{}, false, err
	}
	switch len(droplets) {
	case 0:
		return SFUWindowDroplet{}, false, nil
	case 1:
		if err := a.verifyOwned(droplets[0], name, false); err != nil {
			return SFUWindowDroplet{}, false, err
		}
		node, err := mapSFUWindowDroplet(droplets[0])
		node.Outdated = droplets[0].Image.ID != a.snapshotID
		return node, err == nil, err
	default:
		return SFUWindowDroplet{}, false, fmt.Errorf("%w: %d droplets", ErrSFUWindowDuplicate, len(droplets))
	}
}

// Create submits one droplet creation. A failure that is not
// ErrSFUWindowCreateUnknown is either a preflight failure or a definitive
// provider rejection; an unknown outcome may have created a Droplet.
func (a *SFUWindow) Create(ctx context.Context, name string) (int64, error) {
	if !validSFUWindowName(name) {
		return 0, ErrSFUWindowInvalid
	}
	a.createMu.Lock()
	defer a.createMu.Unlock()
	if err := a.verifyFirewall(ctx); err != nil {
		return 0, err
	}
	droplets, err := a.dropletsNamed(ctx, name)
	if err != nil {
		return 0, err
	}
	if len(droplets) > 0 {
		if len(droplets) > 1 {
			return 0, fmt.Errorf("%w: %d droplets", ErrSFUWindowDuplicate, len(droplets))
		}
		if err := a.verifyOwned(droplets[0], name, true); err != nil {
			return 0, err
		}
		return 0, ErrSFUWindowExists
	}

	payload := sfuWindowCreateRequest{
		Name: name, Region: a.region, Size: SFUWindowSize, Image: a.snapshotID, Tags: a.expectedTags(), VPCUUID: a.vpcUUID,
		UserData: a.telemetry.userData(),
	}
	var response struct {
		Droplet sfuWindowDropletJSON `json:"droplet"`
	}
	if err := a.send(ctx, http.MethodPost, "/v2/droplets", nil, payload, &response, http.StatusAccepted); err != nil {
		var status *digitalOceanHTTPStatusError
		if errors.As(err, &status) {
			switch status.status {
			case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusTooManyRequests:
				return 0, err
			}
		}
		return 0, fmt.Errorf("%w: %w", ErrSFUWindowCreateUnknown, err)
	}
	if response.Droplet.ID <= 0 || response.Droplet.Name != name {
		return 0, fmt.Errorf("%w: %w", ErrSFUWindowCreateUnknown, ErrSFUWindowDrift)
	}
	if err := a.verifyCreateResponse(response.Droplet, name); err != nil {
		return response.Droplet.ID, fmt.Errorf("%w: %w", ErrSFUWindowCreateUnknown, err)
	}
	slog.InfoContext(ctx, "sfu window droplet creation accepted",
		"event", "sfu_window.create_accepted",
		"node_name", name,
		"provider_id", strconv.FormatInt(response.Droplet.ID, 10),
	)
	return response.Droplet.ID, nil
}

// Destroy deletes the droplet with providerID only after reading it back by ID
// and confirming it is the exact window node called name. A missing droplet is success.
func (a *SFUWindow) Destroy(ctx context.Context, name string, providerID int64) error {
	_, present, err := a.Inspect(ctx, name, providerID)
	if err != nil || !present {
		return err
	}
	path := "/v2/droplets/" + strconv.FormatInt(providerID, 10)
	err = a.send(ctx, http.MethodDelete, path, nil, nil, nil, http.StatusNoContent)
	if errors.Is(err, errNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sfu window droplet deletion accepted",
		"event", "sfu_window.destroy_accepted",
		"node_name", name,
		"provider_id", strconv.FormatInt(providerID, 10),
	)
	return nil
}

// Inspect confirms that the immutable provider ID still owns the window name.
func (a *SFUWindow) Inspect(ctx context.Context, name string, providerID int64) (SFUWindowDroplet, bool, error) {
	if !validSFUWindowName(name) || providerID <= 0 {
		return SFUWindowDroplet{}, false, ErrSFUWindowInvalid
	}
	path := "/v2/droplets/" + strconv.FormatInt(providerID, 10)
	var response struct {
		Droplet sfuWindowDropletJSON `json:"droplet"`
	}
	err := a.send(ctx, http.MethodGet, path, nil, nil, &response, http.StatusOK)
	if errors.Is(err, errNotFound) {
		// A token from another account also returns 404. Prove visibility
		// of the pinned environment firewall before accepting absence.
		return SFUWindowDroplet{}, false, a.verifyFirewall(ctx)
	}
	if err != nil {
		return SFUWindowDroplet{}, false, err
	}
	if response.Droplet.ID != providerID {
		return SFUWindowDroplet{}, false, fmt.Errorf("%w: provider ID mismatch", ErrSFUWindowDrift)
	}
	if err := a.verifyOwned(response.Droplet, name, false); err != nil {
		return SFUWindowDroplet{}, false, err
	}
	node, err := mapSFUWindowDroplet(response.Droplet)
	node.Outdated = response.Droplet.Image.ID != a.snapshotID
	return node, err == nil, err
}
