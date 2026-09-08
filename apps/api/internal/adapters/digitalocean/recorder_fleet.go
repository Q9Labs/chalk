package digitalocean

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
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
	Token       string
	BaseURL     string
	HTTPClient  *http.Client
	Environment string
	Role        workeridentity.Role
	OwnerTag    string
	ProjectID   string
	VPCUUID     string
	GPU         bool
}

type RecorderFleet struct {
	baseURL     *url.URL
	client      *http.Client
	environment string
	gpu         bool
	ownerTag    string
	projectID   string
	role        workeridentity.Role
	token       string
	vpcUUID     string
}

func NewRecorderFleet(config RecorderFleetConfig) (*RecorderFleet, error) {
	if config.BaseURL == "" {
		config.BaseURL = defaultBaseURL
	}
	baseURL, err := url.Parse(config.BaseURL)
	key := recorderfleet.PoolKey{Environment: config.Environment, Role: config.Role}
	roleGPUValid := config.Role == workeridentity.RoleCapture && !config.GPU || config.Role == workeridentity.RoleRender && config.GPU
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.Path != "" && baseURL.Path != "/" || strings.TrimSpace(config.Token) == "" || len(config.Token) > 4096 || key.Validate() != nil || !validDigitalOceanTag(config.OwnerTag) || !roleGPUValid || !validOptionalIdentifier(config.ProjectID) || !validOptionalIdentifier(config.VPCUUID) {
		return nil, recorderfleet.ErrInvalidConfig
	}
	if config.HTTPClient == nil {
		config.HTTPClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &RecorderFleet{
		baseURL: baseURL, client: config.HTTPClient, environment: config.Environment,
		gpu: config.GPU, ownerTag: config.OwnerTag, projectID: config.ProjectID,
		role: config.Role, token: config.Token, vpcUUID: config.VPCUUID,
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
	nodes := make([]recorderfleet.Node, 0, len(droplets))
	for _, droplet := range droplets {
		if !slices.Contains(droplet.Tags, recorderfleet.EnvironmentTag(a.environment)) {
			continue
		}
		node, err := a.mapNode(ctx, droplet, slices.Contains(droplet.Tags, recorderfleet.RoleTag(a.role)))
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, node)
	}
	slices.SortFunc(nodes, func(left, right recorderfleet.Node) int { return strings.Compare(left.ProviderID, right.ProviderID) })
	return nodes, nil
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

	userData, err := renderRecorderCloudInit(request)
	if err != nil {
		return recorderfleet.Node{}, err
	}
	payload := createDropletRequest{
		Name: request.Name, Region: request.Release.Region, Size: request.Release.Size,
		Image: request.Release.ImageID, Monitoring: true, Tags: append([]string(nil), request.RequiredTags...),
		UserData: userData, VPCUUID: a.vpcUUID,
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

func (a *RecorderFleet) DeleteNode(ctx context.Context, request recorderfleet.DeleteNodeRequest) error {
	providerID, err := strconv.ParseInt(request.ProviderID, 10, 64)
	if err != nil || providerID <= 0 || strings.TrimSpace(request.Name) == "" || len(request.RequiredTags) == 0 {
		return recorderfleet.ErrInventoryDrift
	}
	var response retrieveDropletResponse
	err = a.doJSON(ctx, http.MethodGet, "/v2/droplets/"+strconv.FormatInt(providerID, 10), nil, nil, &response, http.StatusOK)
	if errors.Is(err, errNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if response.Droplet.Name != request.Name || !slices.Contains(response.Droplet.Tags, a.ownerTag) || !slices.Contains(response.Droplet.Tags, recorderfleet.EnvironmentTag(a.environment)) || !slices.Contains(response.Droplet.Tags, recorderfleet.RoleTag(a.role)) {
		return recorderfleet.ErrInventoryDrift
	}
	for _, tag := range request.RequiredTags {
		if !slices.Contains(response.Droplet.Tags, tag) {
			return recorderfleet.ErrInventoryDrift
		}
	}
	return a.doJSON(ctx, http.MethodDelete, "/v2/droplets/"+strconv.FormatInt(providerID, 10), nil, nil, nil, http.StatusNoContent)
}

func (a *RecorderFleet) validateKey(key recorderfleet.PoolKey) error {
	if a == nil || key.Environment != a.environment || key.Role != a.role {
		return recorderfleet.ErrRoleFence
	}
	return key.Validate()
}

func (a *RecorderFleet) findDropletsByName(ctx context.Context, name string) ([]digitalOceanDroplet, error) {
	query := url.Values{"per_page": {strconv.Itoa(dropletsPerPage)}}
	if a.gpu {
		query.Set("type", "gpus")
	} else {
		query.Set("name", name)
	}
	droplets, err := a.listDroplets(ctx, query)
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(droplets, func(droplet digitalOceanDroplet) bool { return droplet.Name != name }), nil
}

func (a *RecorderFleet) listDroplets(ctx context.Context, query url.Values) ([]digitalOceanDroplet, error) {
	path := "/v2/droplets"
	droplets := make([]digitalOceanDroplet, 0)
	for {
		var response listDropletsResponse
		if err := a.doJSON(ctx, http.MethodGet, path, query, nil, &response, http.StatusOK); err != nil {
			return nil, err
		}
		droplets = append(droplets, response.Droplets...)
		if response.Links.Pages.Next == "" {
			return droplets, nil
		}
		next, err := url.Parse(response.Links.Pages.Next)
		if err != nil || next.Scheme != a.baseURL.Scheme || next.Host != a.baseURL.Host || next.User != nil {
			return nil, recorderfleet.ErrProviderUnavailable
		}
		path = next.Path
		query = next.Query()
	}
}

func (a *RecorderFleet) mapNode(ctx context.Context, droplet digitalOceanDroplet, includeFirewalls bool) (recorderfleet.Node, error) {
	createdAt, _ := time.Parse(time.RFC3339, droplet.CreatedAt)
	node := recorderfleet.Node{
		ProviderID: strconv.FormatInt(droplet.ID, 10), Name: droplet.Name, Status: droplet.Status,
		Region: droplet.Region.Slug, Size: droplet.SizeSlug, ImageID: droplet.Image.ID,
		Tags: append([]string(nil), droplet.Tags...), BootGeneration: bootGeneration(droplet.Tags), CreatedAt: createdAt,
	}
	if !includeFirewalls {
		return node, nil
	}
	var response listFirewallsResponse
	if err := a.doJSON(ctx, http.MethodGet, "/v2/droplets/"+node.ProviderID+"/firewalls", nil, nil, &response, http.StatusOK); err != nil {
		return recorderfleet.Node{}, err
	}
	node.FirewallIDs = node.FirewallIDs[:0]
	for _, firewall := range response.Firewalls {
		node.FirewallIDs = append(node.FirewallIDs, firewall.ID)
	}
	slices.Sort(node.FirewallIDs)
	return node, nil
}

func (a *RecorderFleet) ensureFirewall(ctx context.Context, node recorderfleet.Node, firewallID string) (recorderfleet.Node, error) {
	if slices.Contains(node.FirewallIDs, firewallID) {
		return node, nil
	}
	providerID, err := strconv.ParseInt(node.ProviderID, 10, 64)
	if err != nil || providerID <= 0 {
		return recorderfleet.Node{}, recorderfleet.ErrInventoryDrift
	}
	payload := firewallDropletsRequest{DropletIDs: []int64{providerID}}
	if err := a.doJSON(ctx, http.MethodPost, "/v2/firewalls/"+url.PathEscape(firewallID)+"/droplets", nil, payload, nil, http.StatusNoContent); err != nil {
		return recorderfleet.Node{}, err
	}
	var response listFirewallsResponse
	if err := a.doJSON(ctx, http.MethodGet, "/v2/droplets/"+node.ProviderID+"/firewalls", nil, nil, &response, http.StatusOK); err != nil {
		return recorderfleet.Node{}, err
	}
	for _, firewall := range response.Firewalls {
		node.FirewallIDs = append(node.FirewallIDs, firewall.ID)
	}
	slices.Sort(node.FirewallIDs)
	if !slices.Contains(node.FirewallIDs, firewallID) {
		return recorderfleet.Node{}, recorderfleet.ErrInventoryDrift
	}
	return node, nil
}

func (a *RecorderFleet) ensureProject(ctx context.Context, node recorderfleet.Node) error {
	if a.projectID == "" {
		return nil
	}
	resourceURN := "do:droplet:" + node.ProviderID
	payload := projectResourcesRequest{Resources: []string{resourceURN}}
	var response projectResourcesResponse
	if err := a.doJSON(ctx, http.MethodPost, "/v2/projects/"+url.PathEscape(a.projectID)+"/resources", nil, payload, &response, http.StatusOK); err != nil {
		return err
	}
	for _, resource := range response.Resources {
		if resource.URN == resourceURN && (resource.Status == "ok" || resource.Status == "assigned" || resource.Status == "already_assigned") {
			return nil
		}
	}
	return recorderfleet.ErrInventoryDrift
}

func (a *RecorderFleet) doJSON(ctx context.Context, method, path string, query url.Values, input, output any, expectedStatus int) error {
	endpoint := a.baseURL.ResolveReference(&url.URL{Path: path, RawQuery: query.Encode()})
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return recorderfleet.ErrInvalidConfig
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return recorderfleet.ErrInvalidConfig
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.token)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := a.client.Do(request)
	if err != nil {
		return fmt.Errorf("%w: DigitalOcean request", recorderfleet.ErrProviderUnavailable)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		return errNotFound
	}
	if response.StatusCode != expectedStatus {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		return fmt.Errorf("%w: DigitalOcean status %d", recorderfleet.ErrProviderUnavailable, response.StatusCode)
	}
	if output == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maximumResponseBytes))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("%w: invalid DigitalOcean response", recorderfleet.ErrProviderUnavailable)
	}
	return nil
}

func renderRecorderCloudInit(request recorderfleet.EnsureNodeRequest) (string, error) {
	if err := request.Validate(); err != nil {
		return "", err
	}
	values := []string{
		"CHALK_RECORDER_ENVIRONMENT=" + quoteEnv(request.Key.Environment),
		"CHALK_RECORDER_POOL=" + quoteEnv(string(request.Key.Role)),
		"CHALK_RECORDER_RELEASE=" + quoteEnv(request.Release.ReleaseID),
		"CHALK_RECORDER_IMAGE_DIGEST=" + quoteEnv(request.Release.ImageDigest),
		"CHALK_RECORDER_BOOTSTRAP_ENDPOINT=" + quoteEnv(request.Release.BootstrapEndpoint),
		"CHALK_RECORDER_BOOT_GENERATION=" + quoteEnv(strconv.FormatUint(request.BootGeneration, 10)),
		"CHALK_RECORDER_BOOTSTRAP_ASSERTION_SOURCE=" + quoteEnv("external-reconciler"),
	}
	return "#cloud-config\nwrite_files:\n  - path: /etc/chalk-recorder/bootstrap.env\n    permissions: \"0400\"\n    owner: root:root\n    content: |\n      " + strings.Join(values, "\n      ") + "\nruncmd:\n  - [ \"/usr/local/sbin/chalk-recorder-bootstrap\", \"--one-time\", \"--require-signed-assertion\", \"--require-droplet-inventory-match\", \"--require-boot-generation\", \"--env-file\", \"/etc/chalk-recorder/bootstrap.env\" ]\n  - [ \"/usr/bin/rm\", \"-f\", \"/etc/chalk-recorder/bootstrap.env\" ]\n", nil
}

func quoteEnv(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func validDigitalOceanTag(value string) bool {
	if value == "" || len(value) > 255 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || strings.ContainsRune("_:-", character) {
			continue
		}
		return false
	}
	return true
}

func validOptionalIdentifier(value string) bool {
	return value == "" || strings.TrimSpace(value) == value && len(value) <= 128 && !strings.ContainsAny(value, "\r\n\x00")
}

func nodeMatchesEnsure(node recorderfleet.Node, request recorderfleet.EnsureNodeRequest, requireFirewall bool) bool {
	if node.Name != request.Name || node.Region != request.Release.Region || node.Size != request.Release.Size || node.ImageID != request.Release.ImageID || node.BootGeneration != request.BootGeneration {
		return false
	}
	for _, tag := range request.RequiredTags {
		if !slices.Contains(node.Tags, tag) {
			return false
		}
	}
	return !requireFirewall || slices.Contains(node.FirewallIDs, request.Release.FirewallID)
}

func bootGeneration(tags []string) uint64 {
	var generation uint64
	for _, tag := range tags {
		value, found := strings.CutPrefix(tag, "chalk-boot-")
		if !found {
			continue
		}
		parsed, err := strconv.ParseUint(value, 10, 64)
		if err != nil || parsed == 0 || generation != 0 {
			return 0
		}
		generation = parsed
	}
	return generation
}

type digitalOceanDroplet struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	SizeSlug  string `json:"size_slug"`
	CreatedAt string `json:"created_at"`
	Region    struct {
		Slug string `json:"slug"`
	} `json:"region"`
	Image struct {
		ID int64 `json:"id"`
	} `json:"image"`
	Tags []string `json:"tags"`
}

type listDropletsResponse struct {
	Droplets []digitalOceanDroplet `json:"droplets"`
	Links    struct {
		Pages struct {
			Next string `json:"next"`
		} `json:"pages"`
	} `json:"links"`
}

type createDropletRequest struct {
	Name       string   `json:"name"`
	Region     string   `json:"region"`
	Size       string   `json:"size"`
	Image      int64    `json:"image"`
	Monitoring bool     `json:"monitoring"`
	Tags       []string `json:"tags"`
	UserData   string   `json:"user_data"`
	VPCUUID    string   `json:"vpc_uuid,omitempty"`
}

type createDropletResponse struct {
	Droplet digitalOceanDroplet `json:"droplet"`
}

type retrieveDropletResponse struct {
	Droplet digitalOceanDroplet `json:"droplet"`
}

type listFirewallsResponse struct {
	Firewalls []struct {
		ID string `json:"id"`
	} `json:"firewalls"`
}

type firewallDropletsRequest struct {
	DropletIDs []int64 `json:"droplet_ids"`
}

type projectResourcesRequest struct {
	Resources []string `json:"resources"`
}

type projectResourcesResponse struct {
	Resources []struct {
		Status string `json:"status"`
		URN    string `json:"urn"`
	} `json:"resources"`
}

var errNotFound = errors.New("DigitalOcean resource not found")

var _ recorderfleet.Provider = (*RecorderFleet)(nil)
