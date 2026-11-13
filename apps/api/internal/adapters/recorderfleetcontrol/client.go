package recorderfleetcontrol

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"sync"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	maximumResponseBytes = 1 << 20
	fleetPath            = "/internal/v1/recorder/fleet"
)

type Config struct {
	BaseURL    string
	HTTPClient *http.Client
	Key        recorderfleet.PoolKey
	Logger     *slog.Logger
}

type Client struct {
	baseURL      *url.URL
	client       *http.Client
	key          recorderfleet.PoolKey
	logger       *slog.Logger
	slotFallback sync.Once
}

func New(config Config) (*Client, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.Path != "" && baseURL.Path != "/" || config.Key.Validate() != nil || config.HTTPClient == nil {
		return nil, recorderfleet.ErrInvalidConfig
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	return &Client{baseURL: baseURL, client: config.HTTPClient, key: config.Key, logger: config.Logger}, nil
}

func (c *Client) GetDemand(ctx context.Context, key recorderfleet.PoolKey) (recorderfleet.Demand, error) {
	return c.getDemand(ctx, key, false)
}

func (c *Client) WaitForDemand(ctx context.Context, key recorderfleet.PoolKey) (recorderfleet.Demand, error) {
	return c.getDemand(ctx, key, true)
}

func (c *Client) getDemand(ctx context.Context, key recorderfleet.PoolKey, wait bool) (recorderfleet.Demand, error) {
	if err := c.validateKey(key); err != nil {
		return recorderfleet.Demand{}, err
	}
	query := url.Values{"role": {string(key.Role)}}
	if wait {
		query.Set("wait", "8")
	}
	var response demandResponse
	if err := c.doJSON(ctx, http.MethodGet, fleetPath+"/demand", query, nil, &response, http.StatusOK); err != nil {
		return recorderfleet.Demand{}, err
	}
	if response.Environment != key.Environment || response.Role != key.Role {
		return recorderfleet.Demand{}, recorderfleet.ErrRoleFence
	}
	switch response.SchemaVersion {
	case recorderfleet.DemandSchemaVersion:
		if response.CaptureCapacity != nil {
			return recorderfleet.Demand{}, recorderfleet.ErrInvalidDemand
		}
		if key.Role == workeridentity.RoleCapture {
			c.slotFallback.Do(func() {
				c.logger.WarnContext(ctx, "recorder fleet API lacks slot demand; using one slot per Capture node", "reason", "legacy_demand", "slots_per_node", 1)
			})
		}
	case recorderfleet.SlotDemandSchemaVersion:
		capacity := response.CaptureCapacity
		if key.Role != workeridentity.RoleCapture || capacity == nil || capacity.SlotDemand == nil || capacity.PhysicalNodeFloor == nil {
			return recorderfleet.Demand{}, recorderfleet.ErrInvalidDemand
		}
		response.Demand.CaptureCapacity = &recorderfleet.CaptureCapacityDemand{SlotDemand: *capacity.SlotDemand, PhysicalNodeFloor: *capacity.PhysicalNodeFloor}
	default:
		return recorderfleet.Demand{}, recorderfleet.ErrRoleFence
	}
	if err := response.Demand.Validate(); err != nil {
		return recorderfleet.Demand{}, err
	}
	return response.Demand, nil
}

func (c *Client) ObserveNodes(ctx context.Context, key recorderfleet.PoolKey) ([]recorderfleet.NodeObservation, error) {
	if err := c.validateKey(key); err != nil {
		return nil, err
	}
	query := url.Values{"role": {string(key.Role)}}
	var response nodesResponse
	if err := c.doJSON(ctx, http.MethodGet, fleetPath+"/nodes", query, nil, &response, http.StatusOK); err != nil {
		return nil, err
	}
	if response.SchemaVersion != recorderfleet.NodesSchemaVersion || response.Environment != key.Environment || response.Role != key.Role || response.Nodes == nil {
		return nil, recorderfleet.ErrRoleFence
	}
	return append([]recorderfleet.NodeObservation(nil), response.Nodes...), nil
}

func (c *Client) ObserveIdentity(ctx context.Context, identity recorderfleet.NodeIdentity) (recorderfleet.NodeObservation, error) {
	if c == nil || !validPathSegment(identity.ProviderID) || identity.Role != c.key.Role || identity.BootGeneration == 0 {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrRoleFence
	}
	workerID, err := utilities.ParseID(identity.WorkerID)
	if err != nil || workerID.IsZero() {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrRoleFence
	}
	body := commandRequest{SchemaVersion: recorderfleet.CommandSchemaVersion, Environment: c.key.Environment, Identity: identity}
	var response struct {
		SchemaVersion string `json:"schema_version"`
		Environment   string `json:"environment"`
		Observation   struct {
			recorderfleet.NodeObservation
			ActiveLeases *int `json:"active_leases"`
		} `json:"observation"`
	}
	if err := c.doJSON(ctx, http.MethodPost, fleetPath+"/nodes/"+url.PathEscape(identity.ProviderID)+"/leases", nil, body, &response, http.StatusOK); err != nil {
		return recorderfleet.NodeObservation{}, err
	}
	observation := response.Observation.NodeObservation
	if response.SchemaVersion != recorderfleet.CommandSchemaVersion || response.Environment != c.key.Environment || observation.Identity != identity || observation.LeasesObservedAt.IsZero() || response.Observation.ActiveLeases == nil || *response.Observation.ActiveLeases < 0 {
		return recorderfleet.NodeObservation{}, recorderfleet.ErrRoleFence
	}
	observation.ActiveLeases = *response.Observation.ActiveLeases
	return observation, nil
}

func (c *Client) EnsureBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	if err := c.validateKey(request.Key); err != nil || !validPathSegment(request.ProviderID) || request.NodeName == "" || request.BootGeneration == 0 || request.InventoryDigest == "" {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	body := bootstrapRequest{SchemaVersion: recorderfleet.BootstrapSchemaVersion, BootstrapRequest: request}
	var response bootstrapResponse
	if err := c.doJSON(ctx, http.MethodPost, fleetPath+"/nodes/"+url.PathEscape(request.ProviderID)+"/bootstrap", nil, body, &response, http.StatusOK); err != nil {
		return recorderfleet.NodeIdentity{}, err
	}
	identity := response.Identity
	if response.SchemaVersion != recorderfleet.BootstrapSchemaVersion || response.Environment != request.Key.Environment || response.Role != request.Key.Role || identity.ProviderID != request.ProviderID || identity.Role != request.Key.Role || identity.BootGeneration != request.BootGeneration {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	if _, err := utilities.ParseID(identity.WorkerID); err != nil {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	return identity, nil
}

func (c *Client) AbandonBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest) error {
	if err := c.validateKey(request.Key); err != nil || request.Validate() != nil || !validPathSegment(request.ProviderID) {
		return recorderfleet.ErrRoleFence
	}
	body := bootstrapRequest{SchemaVersion: recorderfleet.BootstrapAbandonSchemaVersion, BootstrapRequest: request}
	return c.doJSON(ctx, http.MethodPost, fleetPath+"/nodes/"+url.PathEscape(request.ProviderID)+"/bootstrap/abandon", nil, body, nil, http.StatusNoContent)
}

func (c *Client) CloseAdmission(ctx context.Context, identity recorderfleet.NodeIdentity) error {
	return c.nodeCommand(ctx, identity, "admission/close")
}

func (c *Client) RevokeIdentity(ctx context.Context, identity recorderfleet.NodeIdentity) error {
	return c.nodeCommand(ctx, identity, "identity/revoke")
}

func (c *Client) PublishPool(ctx context.Context, projection recorderfleet.PoolProjection) error {
	if err := c.validateKey(projection.Key); err != nil || projection.DemandRevision == "" || projection.ReadyCapacity < 0 || projection.ObservedAt.IsZero() || projection.Reason == "" {
		return recorderfleet.ErrRoleFence
	}
	body := poolRequest{SchemaVersion: recorderfleet.PoolSchemaVersion, PoolProjection: projection}
	return c.doJSON(ctx, http.MethodPut, fleetPath+"/pool", nil, body, nil, http.StatusNoContent)
}

func (c *Client) nodeCommand(ctx context.Context, identity recorderfleet.NodeIdentity, operation string) error {
	if !validPathSegment(identity.ProviderID) || identity.Role != c.key.Role || identity.BootGeneration == 0 {
		return recorderfleet.ErrRoleFence
	}
	if _, err := utilities.ParseID(identity.WorkerID); err != nil {
		return recorderfleet.ErrRoleFence
	}
	body := commandRequest{SchemaVersion: recorderfleet.CommandSchemaVersion, Environment: c.key.Environment, Identity: identity}
	return c.doJSON(ctx, http.MethodPost, fleetPath+"/nodes/"+url.PathEscape(identity.ProviderID)+"/"+operation, nil, body, nil, http.StatusNoContent)
}

func (c *Client) validateKey(key recorderfleet.PoolKey) error {
	if c == nil || key != c.key {
		return recorderfleet.ErrRoleFence
	}
	return key.Validate()
}

var (
	_ recorderfleet.DemandSource       = (*Client)(nil)
	_ recorderfleet.BootstrapAuthority = (*Client)(nil)
	_ recorderfleet.RuntimeControl     = (*Client)(nil)
)
