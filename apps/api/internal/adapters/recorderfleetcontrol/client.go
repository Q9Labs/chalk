package recorderfleetcontrol

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

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
}

type Client struct {
	baseURL *url.URL
	client  *http.Client
	key     recorderfleet.PoolKey
}

func New(config Config) (*Client, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.Path != "" && baseURL.Path != "/" || config.Key.Validate() != nil || config.HTTPClient == nil {
		return nil, recorderfleet.ErrInvalidConfig
	}
	return &Client{baseURL: baseURL, client: config.HTTPClient, key: config.Key}, nil
}

func (c *Client) GetDemand(ctx context.Context, key recorderfleet.PoolKey) (recorderfleet.Demand, error) {
	if err := c.validateKey(key); err != nil {
		return recorderfleet.Demand{}, err
	}
	query := url.Values{"role": {string(key.Role)}}
	var response demandResponse
	if err := c.doJSON(ctx, http.MethodGet, fleetPath+"/demand", query, nil, &response, http.StatusOK); err != nil {
		return recorderfleet.Demand{}, err
	}
	if response.SchemaVersion != recorderfleet.DemandSchemaVersion || response.Environment != key.Environment || response.Role != key.Role {
		return recorderfleet.Demand{}, recorderfleet.ErrRoleFence
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

func (c *Client) doJSON(ctx context.Context, method, path string, query url.Values, input, output any, expectedStatus int) error {
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path, RawQuery: query.Encode()})
	var requestBody io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return recorderfleet.ErrInvalidConfig
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), requestBody)
	if err != nil {
		return recorderfleet.ErrInvalidConfig
	}
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("recorder fleet control request: %w", recorderfleet.ErrProviderUnavailable)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil || len(responseBody) > maximumResponseBytes {
		return fmt.Errorf("%w: invalid recorder fleet control response", recorderfleet.ErrProviderUnavailable)
	}
	if response.StatusCode != expectedStatus {
		return fmt.Errorf("%w: recorder fleet control status %d", recorderfleet.ErrProviderUnavailable, response.StatusCode)
	}
	if output == nil {
		if len(bytes.TrimSpace(responseBody)) != 0 {
			return fmt.Errorf("%w: invalid recorder fleet control response", recorderfleet.ErrProviderUnavailable)
		}
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("%w: invalid recorder fleet control response", recorderfleet.ErrProviderUnavailable)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("%w: invalid recorder fleet control response", recorderfleet.ErrProviderUnavailable)
	}
	return nil
}

func validPathSegment(value string) bool {
	if value == "" || len(value) > 128 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "/\\\r\n\x00") {
		return false
	}
	return true
}

type demandResponse struct {
	SchemaVersion string              `json:"schema_version"`
	Environment   string              `json:"environment"`
	Role          workeridentity.Role `json:"role"`
	recorderfleet.Demand
}

type nodesResponse struct {
	SchemaVersion string                          `json:"schema_version"`
	Environment   string                          `json:"environment"`
	Role          workeridentity.Role             `json:"role"`
	Nodes         []recorderfleet.NodeObservation `json:"nodes"`
}

type bootstrapRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.BootstrapRequest
}

type bootstrapResponse struct {
	SchemaVersion string                     `json:"schema_version"`
	Environment   string                     `json:"environment"`
	Role          workeridentity.Role        `json:"role"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type commandRequest struct {
	SchemaVersion string                     `json:"schema_version"`
	Environment   string                     `json:"environment"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type poolRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.PoolProjection
}

func ParseDurationSeconds(value string) (time.Duration, error) {
	seconds, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || seconds <= 0 {
		return 0, recorderfleet.ErrInvalidConfig
	}
	duration := time.Duration(seconds) * time.Second
	if duration/time.Second != time.Duration(seconds) {
		return 0, recorderfleet.ErrInvalidConfig
	}
	return duration, nil
}

var (
	_ recorderfleet.DemandSource       = (*Client)(nil)
	_ recorderfleet.BootstrapAuthority = (*Client)(nil)
	_ recorderfleet.RuntimeControl     = (*Client)(nil)
)
