package digitalocean

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
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
	// ErrSFUWindowCreateUnknown marks every Create failure after the creation
	// request may have reached DigitalOcean. The droplet may exist, so the caller
	// must settle the outcome with Observe and must not treat it as a rejection.
	ErrSFUWindowCreateUnknown = errors.New("sfu window: create outcome unknown")
)

// SFUWindowRateLimitError carries the earliest time DigitalOcean allows another request.
type SFUWindowRateLimitError struct{ RetryAt time.Time }

func (err *SFUWindowRateLimitError) Error() string { return "sfu window: DigitalOcean rate limited" }

// SFUWindowConfig scopes the adapter to one environment's window nodes.
//
// The snapshot must be ready to boot: release preloaded, environment-specific
// node TLS certificate baked in, no secrets in the image or in user data. The
// adapter sends no user data and no SSH keys, and nothing deploys over SSH at
// runtime. OwnerTag is the immutable environment owner tag and must be used by
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
}

// SFUWindowDroplet is the trusted view of one owned window node. Address is the
// droplet's single public IPv4 address, parsed rather than echoed. Active is
// true only once DigitalOcean reports the droplet active and it has that address.
type SFUWindowDroplet struct {
	ID      int64
	Address netip.Addr
	Active  bool
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
	createMu    sync.Mutex
}

func NewSFUWindow(config SFUWindowConfig) (*SFUWindow, error) {
	if config.BaseURL == "" {
		config.BaseURL = defaultBaseURL
	}
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.Path != "" && baseURL.Path != "/" ||
		strings.TrimSpace(config.Token) == "" || len(config.Token) > 4096 ||
		!validDigitalOceanTag(config.OwnerTag) || !validDigitalOceanTag(config.FirewallTag) || config.OwnerTag == config.FirewallTag ||
		!canonicalUUID(config.FirewallID) || !canonicalUUID(config.VPCUUID) || config.SnapshotID <= 0 || !validRegionSlug(config.Region) {
		return nil, ErrSFUWindowInvalid
	}
	client := &http.Client{Timeout: 15 * time.Second}
	if config.HTTPClient != nil {
		copied := *config.HTTPClient
		client = &copied
		if client.Timeout == 0 {
			client.Timeout = 15 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &SFUWindow{
		baseURL: baseURL, client: client, token: config.Token,
		ownerTag: config.OwnerTag, firewallTag: config.FirewallTag, firewallID: config.FirewallID,
		snapshotID: config.SnapshotID, region: config.Region, vpcUUID: config.VPCUUID,
	}, nil
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
		if err := a.verifyOwned(droplets[0], name, true); err != nil {
			return SFUWindowDroplet{}, false, err
		}
		node, err := mapSFUWindowDroplet(droplets[0])
		return node, err == nil, err
	default:
		return SFUWindowDroplet{}, false, fmt.Errorf("%w: %d droplets", ErrSFUWindowDuplicate, len(droplets))
	}
}

// Create submits one droplet creation. A failure that is not
// ErrSFUWindowCreateUnknown guarantees no creation request was sent; every other
// failure may have created the droplet. It never retries.
func (a *SFUWindow) Create(ctx context.Context, name string) error {
	if !validSFUWindowName(name) {
		return ErrSFUWindowInvalid
	}
	a.createMu.Lock()
	defer a.createMu.Unlock()
	if err := a.verifyFirewall(ctx); err != nil {
		return err
	}
	droplets, err := a.dropletsNamed(ctx, name)
	if err != nil {
		return err
	}
	if len(droplets) > 0 {
		if len(droplets) > 1 {
			return fmt.Errorf("%w: %d droplets", ErrSFUWindowDuplicate, len(droplets))
		}
		if err := a.verifyOwned(droplets[0], name, true); err != nil {
			return err
		}
		return ErrSFUWindowExists
	}

	payload := sfuWindowCreateRequest{
		Name: name, Region: a.region, Size: SFUWindowSize, Image: a.snapshotID, Tags: a.expectedTags(), VPCUUID: a.vpcUUID,
	}
	var response struct {
		Droplet sfuWindowDropletJSON `json:"droplet"`
	}
	if err := a.send(ctx, http.MethodPost, "/v2/droplets", nil, payload, &response, http.StatusAccepted); err != nil {
		return fmt.Errorf("%w: %w", ErrSFUWindowCreateUnknown, err)
	}
	if err := a.verifyOwned(response.Droplet, name, false); err != nil {
		return fmt.Errorf("%w: %w", ErrSFUWindowCreateUnknown, err)
	}
	slog.InfoContext(ctx, "sfu window droplet creation accepted",
		"event", "sfu_window.create_accepted",
		"node_name", name,
		"provider_id", strconv.FormatInt(response.Droplet.ID, 10),
	)
	return nil
}

// Destroy deletes the droplet with providerID only after reading it back by ID
// and confirming it is the exact window node called name. A missing droplet is success.
func (a *SFUWindow) Destroy(ctx context.Context, name string, providerID int64) error {
	if !validSFUWindowName(name) || providerID <= 0 {
		return ErrSFUWindowInvalid
	}
	path := "/v2/droplets/" + strconv.FormatInt(providerID, 10)
	var response struct {
		Droplet sfuWindowDropletJSON `json:"droplet"`
	}
	err := a.send(ctx, http.MethodGet, path, nil, nil, &response, http.StatusOK)
	if errors.Is(err, errNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if response.Droplet.ID != providerID {
		return fmt.Errorf("%w: provider ID mismatch", ErrSFUWindowDrift)
	}
	if err := a.verifyOwned(response.Droplet, name, false); err != nil {
		return err
	}
	err = a.send(ctx, http.MethodDelete, path, nil, nil, nil, http.StatusNoContent)
	if errors.Is(err, errNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sfu window droplet deleted",
		"event", "sfu_window.destroyed",
		"node_name", name,
		"provider_id", strconv.FormatInt(providerID, 10),
	)
	return nil
}

func (a *SFUWindow) expectedTags() []string {
	tags := []string{a.ownerTag, a.firewallTag}
	slices.Sort(tags)
	return tags
}

// verifyOwned pins the droplet to the exact identity this adapter creates.
// Destroy skips the image so a snapshot roll cannot strand a running node.
func (a *SFUWindow) verifyOwned(droplet sfuWindowDropletJSON, name string, checkImage bool) error {
	tags := slices.Clone(droplet.Tags)
	slices.Sort(tags)
	switch {
	case droplet.ID <= 0, droplet.Name != name, droplet.SizeSlug != SFUWindowSize, droplet.Region.Slug != a.region, droplet.VPCUUID != a.vpcUUID,
		!slices.Equal(tags, a.expectedTags()), checkImage && droplet.Image.ID != a.snapshotID:
		return ErrSFUWindowDrift
	}
	return nil
}

func mapSFUWindowDroplet(droplet sfuWindowDropletJSON) (SFUWindowDroplet, error) {
	var address netip.Addr
	for _, network := range droplet.Networks.V4 {
		if network.Type != "public" {
			continue
		}
		parsed, err := netip.ParseAddr(network.IPAddress)
		if err != nil || !parsed.Is4() || !parsed.IsGlobalUnicast() || parsed.IsPrivate() || address.IsValid() {
			return SFUWindowDroplet{}, fmt.Errorf("%w: public IPv4 address", ErrSFUWindowDrift)
		}
		address = parsed
	}
	return SFUWindowDroplet{ID: droplet.ID, Address: address, Active: droplet.Status == "active" && address.IsValid()}, nil
}

// dropletsNamed returns every droplet whose name equals name ignoring case, so a
// case variant is surfaced to verifyOwned instead of being ignored.
func (a *SFUWindow) dropletsNamed(ctx context.Context, name string) ([]sfuWindowDropletJSON, error) {
	path := "/v2/droplets"
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}, "name": {name}}
	var matches []sfuWindowDropletJSON
	for page := 0; page < sfuWindowMaxPages; page++ {
		var response struct {
			Droplets []sfuWindowDropletJSON `json:"droplets"`
			Links    struct {
				Pages struct {
					Next string `json:"next"`
				} `json:"pages"`
			} `json:"links"`
		}
		if err := a.send(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return nil, err
		}
		for _, droplet := range response.Droplets {
			if strings.EqualFold(droplet.Name, name) {
				matches = append(matches, droplet)
			}
		}
		if response.Links.Pages.Next == "" {
			return matches, nil
		}
		next, err := a.nextQuery(response.Links.Pages.Next, path)
		if err != nil {
			return nil, err
		}
		query = next
	}
	return nil, fmt.Errorf("%w: too many pages", ErrSFUWindowProvider)
}

// verifyFirewall requires FirewallID to be the one succeeded firewall that
// targets exactly FirewallTag, and no other firewall to target either window tag.
func (a *SFUWindow) verifyFirewall(ctx context.Context) error {
	path := "/v2/firewalls"
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}}
	found := false
	for page := 0; page < sfuWindowMaxPages; page++ {
		var response struct {
			Firewalls []struct {
				ID     string   `json:"id"`
				Status string   `json:"status"`
				Tags   []string `json:"tags"`
			} `json:"firewalls"`
			Links struct {
				Pages struct {
					Next string `json:"next"`
				} `json:"pages"`
			} `json:"links"`
		}
		if err := a.send(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return err
		}
		for _, firewall := range response.Firewalls {
			targetsWindow := slices.Contains(firewall.Tags, a.ownerTag) || slices.Contains(firewall.Tags, a.firewallTag)
			switch {
			case firewall.ID == a.firewallID:
				if firewall.Status != "succeeded" || !slices.Equal(firewall.Tags, []string{a.firewallTag}) {
					return ErrSFUWindowFirewall
				}
				found = true
			case targetsWindow:
				return ErrSFUWindowFirewall
			}
		}
		if response.Links.Pages.Next == "" {
			if !found {
				return ErrSFUWindowFirewall
			}
			return nil
		}
		next, err := a.nextQuery(response.Links.Pages.Next, path)
		if err != nil {
			return err
		}
		query = next
	}
	return fmt.Errorf("%w: too many pages", ErrSFUWindowProvider)
}

func (a *SFUWindow) nextQuery(next, expectedPath string) (url.Values, error) {
	parsed, err := url.Parse(next)
	if err != nil || parsed.Scheme != a.baseURL.Scheme || parsed.Host != a.baseURL.Host || parsed.User != nil || parsed.Fragment != "" || parsed.Path != expectedPath {
		return nil, fmt.Errorf("%w: unexpected page link", ErrSFUWindowProvider)
	}
	return parsed.Query(), nil
}

// send makes one bounded request: no redirects, no retries, and a body capped at maximumResponseBytes.
func (a *SFUWindow) send(ctx context.Context, method, path string, query url.Values, input, output any, expectedStatus int) error {
	endpoint := a.baseURL.ResolveReference(&url.URL{Path: path, RawQuery: query.Encode()})
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return ErrSFUWindowInvalid
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return ErrSFUWindowInvalid
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.token)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := a.client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("%w: %s: %w", ErrSFUWindowProvider, method, ctxErr)
		}
		return fmt.Errorf("%w: %s %s", ErrSFUWindowProvider, method, path)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil || len(payload) > maximumResponseBytes {
		return fmt.Errorf("%w: unreadable or oversized response", ErrSFUWindowProvider)
	}
	switch {
	case response.StatusCode == http.StatusTooManyRequests:
		retry := &SFUWindowRateLimitError{RetryAt: retryDeadline(response.Header, time.Now())}
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: fmt.Errorf("%w: status 429: %w", ErrSFUWindowProvider, retry)}
	case response.StatusCode == http.StatusNotFound:
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: errNotFound}
	case response.StatusCode != expectedStatus:
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: fmt.Errorf("%w: status %d", ErrSFUWindowProvider, response.StatusCode)}
	case output == nil:
		return nil
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return fmt.Errorf("%w: invalid response body", ErrSFUWindowProvider)
	}
	return nil
}

type sfuWindowDropletJSON struct {
	digitalOceanDroplet
	VPCUUID string `json:"vpc_uuid"`
}

type sfuWindowCreateRequest struct {
	Name             string   `json:"name"`
	Region           string   `json:"region"`
	Size             string   `json:"size"`
	Image            int64    `json:"image"`
	Tags             []string `json:"tags"`
	VPCUUID          string   `json:"vpc_uuid"`
	Monitoring       bool     `json:"monitoring"`
	WithDropletAgent bool     `json:"with_droplet_agent"`
	IPv6             bool     `json:"ipv6"`
	Backups          bool     `json:"backups"`
}

func validSFUWindowName(name string) bool {
	id, found := strings.CutPrefix(name, sfuWindowNamePrefix)
	return found && canonicalUUID(id)
}

func canonicalUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		switch {
		case index == 8 || index == 13 || index == 18 || index == 23:
			if character != '-' {
				return false
			}
		case character < '0' || character > '9' && character < 'a' || character > 'f':
			return false
		}
	}
	return true
}

func validRegionSlug(value string) bool {
	if len(value) < 4 || len(value) > 5 {
		return false
	}
	for index, character := range value {
		if index < 3 && (character < 'a' || character > 'z') || index >= 3 && (character < '0' || character > '9') {
			return false
		}
	}
	return true
}
