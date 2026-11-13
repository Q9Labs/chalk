package digitalocean

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	defaultBaseURL       = "https://api.digitalocean.com"
	maximumResponseBytes = 1 << 20
	dropletsPerPage      = 200
)

type RecorderFleetConfig struct {
	SlotsPerNode   int
	RequestBudget  *RequestBudget
	PresignArchive func(context.Context, recorderfleet.ArchiveSpec) (string, error)
	Token          string
	BaseURL        string
	HTTPClient     *http.Client
	Now            func() time.Time
	Environment    string
	Role           workeridentity.Role
	OwnerTag       string
	ProjectID      string
	VPCUUID        string
	GPU            bool
	SSHKeyIDs      []int64
}

type RecorderFleet struct {
	slotsPerNode   int
	budget         *RequestBudget
	rateLimitMu    sync.Mutex
	rateLimit      RateLimitSnapshot
	presignArchive func(context.Context, recorderfleet.ArchiveSpec) (string, error)
	baseURL        *url.URL
	client         *http.Client
	environment    string
	gpu            bool
	ownerTag       string
	projectID      string
	role           workeridentity.Role
	token          string
	now            func() time.Time
	vpcUUID        string
	sshKeyIDs      []int64
}

func NewRecorderFleet(config RecorderFleetConfig) (*RecorderFleet, error) {
	if config.SlotsPerNode == 0 {
		config.SlotsPerNode = 1
	}
	if config.BaseURL == "" {
		config.BaseURL = defaultBaseURL
	}
	baseURL, err := url.Parse(config.BaseURL)
	key := recorderfleet.PoolKey{Environment: config.Environment, Role: config.Role}
	roleGPUValid := config.Role == workeridentity.RoleRender || config.Role == workeridentity.RoleCapture && !config.GPU
	if config.SlotsPerNode < 1 || config.SlotsPerNode > 100 || err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.Path != "" && baseURL.Path != "/" || strings.TrimSpace(config.Token) == "" || len(config.Token) > 4096 || key.Validate() != nil || !validDigitalOceanTag(config.OwnerTag) || !roleGPUValid || !validOptionalIdentifier(config.ProjectID) || !validOptionalIdentifier(config.VPCUUID) || !validSSHKeyIDs(config.SSHKeyIDs) {
		return nil, recorderfleet.ErrInvalidConfig
	}
	if config.HTTPClient == nil {
		config.HTTPClient = &http.Client{Timeout: 15 * time.Second}
	}
	if config.RequestBudget == nil {
		config.RequestBudget = NewRequestBudget()
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &RecorderFleet{
		budget:         config.RequestBudget,
		slotsPerNode:   config.SlotsPerNode,
		presignArchive: config.PresignArchive, baseURL: baseURL, client: config.HTTPClient, environment: config.Environment,
		gpu: config.GPU, ownerTag: config.OwnerTag, projectID: config.ProjectID,
		role: config.Role, token: config.Token, now: config.Now, vpcUUID: config.VPCUUID, sshKeyIDs: append([]int64(nil), config.SSHKeyIDs...),
	}, nil
}

func (a *RecorderFleet) ListNodes(ctx context.Context, key recorderfleet.PoolKey) ([]recorderfleet.Node, error) {
	if err := a.validateKey(key); err != nil {
		return nil, err
	}
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}}
	if a.gpu {
		query.Set("type", "gpus")
	} else {
		query.Set("tag_name", recorderfleet.EnvironmentTag(a.environment))
	}
	droplets, err := a.listDroplets(ctx, query)
	if err != nil {
		return nil, err
	}
	var firewalls []digitalOceanFirewall
	for _, droplet := range droplets {
		if slices.Contains(droplet.Tags, recorderfleet.EnvironmentTag(a.environment)) && slices.Contains(droplet.Tags, recorderfleet.RoleTag(a.role)) {
			firewalls, err = a.listFirewalls(ctx)
			if err != nil {
				return nil, err
			}
			break
		}
	}
	nodes := make([]recorderfleet.Node, 0, len(droplets))
	for _, droplet := range droplets {
		if !slices.Contains(droplet.Tags, recorderfleet.EnvironmentTag(a.environment)) {
			continue
		}
		node, err := a.mapNode(ctx, droplet, false)
		if err != nil {
			return nil, err
		}
		if slices.Contains(droplet.Tags, recorderfleet.RoleTag(a.role)) {
			for _, firewall := range firewalls {
				attached := slices.Contains(firewall.DropletIDs, droplet.ID)
				for _, tag := range firewall.Tags {
					attached = attached || slices.Contains(droplet.Tags, tag)
				}
				if attached {
					node.FirewallIDs = append(node.FirewallIDs, firewall.ID)
				}
			}
			slices.Sort(node.FirewallIDs)
		}
		nodes = append(nodes, node)
	}
	slices.SortFunc(nodes, func(left, right recorderfleet.Node) int { return strings.Compare(left.ProviderID, right.ProviderID) })
	return nodes, nil
}

// NodeExists confirms absence only on an exact provider 404, never on a filtered list.
func (a *RecorderFleet) NodeExists(ctx context.Context, key recorderfleet.PoolKey, providerID string) (bool, error) {
	if err := a.validateKey(key); err != nil {
		return false, err
	}
	id, err := strconv.ParseInt(providerID, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != providerID {
		return false, recorderfleet.ErrInventoryDrift
	}
	var response retrieveDropletResponse
	err = a.doJSON(ctx, http.MethodGet, "/v2/droplets/"+providerID, nil, nil, &response, http.StatusOK)
	if errors.Is(err, errNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// InspectNode returns a fresh, exact provider view for bootstrap authorization.
// The public address is accepted only when DigitalOcean reports one exclusive
// public IPv4 address; bootstrap callers are bound to that address at the TCP
// peer rather than to forwarded headers or unsigned metadata.
func (a *RecorderFleet) InspectNode(ctx context.Context, key recorderfleet.PoolKey, providerID string) (recorderfleet.Node, netip.Addr, error) {
	if err := a.validateKey(key); err != nil {
		return recorderfleet.Node{}, netip.Addr{}, err
	}
	id, err := strconv.ParseInt(providerID, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != providerID {
		return recorderfleet.Node{}, netip.Addr{}, recorderfleet.ErrInventoryDrift
	}
	var response retrieveDropletResponse
	if err := a.doJSON(ctx, http.MethodGet, "/v2/droplets/"+providerID, nil, nil, &response, http.StatusOK); err != nil {
		if errors.Is(err, errNotFound) {
			return recorderfleet.Node{}, netip.Addr{}, recorderfleet.ErrNodeNotFound
		}
		return recorderfleet.Node{}, netip.Addr{}, err
	}
	if !slices.Contains(response.Droplet.Tags, a.ownerTag) || !slices.Contains(response.Droplet.Tags, recorderfleet.EnvironmentTag(a.environment)) || !slices.Contains(response.Droplet.Tags, recorderfleet.RoleTag(a.role)) {
		return recorderfleet.Node{}, netip.Addr{}, recorderfleet.ErrInventoryDrift
	}
	node, err := a.mapNode(ctx, response.Droplet, true)
	if err != nil {
		return recorderfleet.Node{}, netip.Addr{}, err
	}
	var publicAddress netip.Addr
	for _, network := range response.Droplet.Networks.V4 {
		if network.Type != "public" {
			continue
		}
		address, parseErr := netip.ParseAddr(network.IPAddress)
		if parseErr != nil || !address.Is4() || publicAddress.IsValid() {
			return recorderfleet.Node{}, netip.Addr{}, recorderfleet.ErrInventoryDrift
		}
		publicAddress = address
	}
	if !publicAddress.IsValid() {
		if node.Status == "new" || node.Status == "active" {
			// Keep the immutable inventory available for the issuer's identity checks.
			return node, netip.Addr{}, fmt.Errorf("%w: public IPv4 is absent", recorderfleet.ErrInventoryNotReady)
		}
		return recorderfleet.Node{}, netip.Addr{}, recorderfleet.ErrInventoryDrift
	}
	return node, publicAddress, nil
}

func (a *RecorderFleet) EnsureNode(ctx context.Context, request recorderfleet.EnsureNodeRequest) (recorderfleet.Node, error) {
	if err := request.Validate(); err != nil || a.validateKey(request.Key) != nil || request.OwnerTag != a.ownerTag || request.Release.GPU != a.gpu {
		return recorderfleet.Node{}, recorderfleet.ErrInvalidConfig
	}
	existing, err := a.findDropletsByName(ctx, request.Name)
	if err != nil {
		return recorderfleet.Node{}, err
	}
	if len(existing) > 1 {
		return recorderfleet.Node{}, recorderfleet.ErrInventoryDrift
	}
	if len(existing) == 1 {
		node, err := a.mapNode(ctx, existing[0], true)
		if err != nil {
			return recorderfleet.Node{}, err
		}
		if !nodeMatchesEnsure(node, request, false) {
			return recorderfleet.Node{}, recorderfleet.ErrInventoryDrift
		}
		if err := a.ensureProject(ctx, node); err != nil {
			return recorderfleet.Node{}, err
		}
		return a.ensureFirewall(ctx, node, request.Release.FirewallID)
	}

	if a.presignArchive == nil {
		return recorderfleet.Node{}, fmt.Errorf("%w: archive signer is unavailable", recorderfleet.ErrProviderUnavailable)
	}
	archiveURL, err := a.presignArchive(ctx, request.Release.Archive)
	if err != nil {
		return recorderfleet.Node{}, fmt.Errorf("%w: recorder archive signing failed", recorderfleet.ErrProviderUnavailable)
	}
	userData, err := renderRecorderCloudInit(request, archiveURL, a.slotsPerNode)
	if err != nil {
		return recorderfleet.Node{}, err
	}
	payload := createDropletRequest{
		Name: request.Name, Region: request.Release.Region, Size: request.Release.Size,
		Image: request.Release.ImageID, Monitoring: false, WithDropletAgent: false, Tags: append([]string(nil), request.RequiredTags...),
		UserData: userData, VPCUUID: a.vpcUUID, SSHKeys: append([]int64(nil), a.sshKeyIDs...),
	}
	var response createDropletResponse
	if err := a.doJSON(ctx, http.MethodPost, "/v2/droplets", nil, payload, &response, http.StatusAccepted); err != nil {
		return recorderfleet.Node{}, err
	}
	node, err := a.mapNode(ctx, response.Droplet, false)
	if err != nil {
		return recorderfleet.Node{}, err
	}
	if !nodeMatchesEnsure(node, request, false) {
		return recorderfleet.Node{}, recorderfleet.ErrInventoryDrift
	}
	if err := a.ensureProject(ctx, node); err != nil {
		return recorderfleet.Node{}, err
	}
	return a.ensureFirewall(ctx, node, request.Release.FirewallID)
}

var _ recorderfleet.Provider = (*RecorderFleet)(nil)
