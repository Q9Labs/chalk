package recorderfleetissuer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mtls"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	BootstrapSchemaVersion = "recorder_fleet_issuer_bootstrap.v1"
	RevokeSchemaVersion    = "recorder_fleet_issuer_revoke.v1"

	bootstrapPath       = "/v1/recorder-fleet/bootstrap"
	revokePath          = "/v1/recorder-fleet/revoke"
	maximumResponseSize = 1 << 20
	defaultTimeout      = 30 * time.Second
)

type Config struct {
	BaseURL        string
	ClientCertFile string
	ClientKeyFile  string
	ServerCAFile   string
	ServerName     string
	Timeout        time.Duration
}

type Client struct {
	baseURL *url.URL
	client  *http.Client
}

func New(config Config) (*Client, error) {
	timeout := config.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	if timeout < 0 {
		return nil, recorderfleet.ErrInvalidConfig
	}
	tlsConfig, err := mtls.LoadClientConfig(config.ClientCertFile, config.ClientKeyFile, config.ServerCAFile, config.ServerName)
	if err != nil {
		return nil, fmt.Errorf("%w: configure recorder fleet issuer mTLS: %v", recorderfleet.ErrInvalidConfig, err)
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment, TLSClientConfig: tlsConfig, ForceAttemptHTTP2: true,
		MaxIdleConns: 8, MaxIdleConnsPerHost: 4, IdleConnTimeout: time.Minute,
	}
	return newClient(config.BaseURL, &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	})
}

// NewWithHTTPClient supplies the issuer transport explicitly. It is intended
// for conformance tests and callers that already enforce equivalent mTLS.
func NewWithHTTPClient(baseURL string, client *http.Client) (*Client, error) {
	return newClient(baseURL, client)
}

func newClient(rawURL string, client *http.Client) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.Path != "" && baseURL.Path != "/" || client == nil {
		return nil, recorderfleet.ErrInvalidConfig
	}
	return &Client{baseURL: baseURL, client: client}, nil
}

func (c *Client) EnsureBootstrap(ctx context.Context, request recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	if c == nil || request.Validate() != nil {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	var response bootstrapResponse
	if err := c.doJSON(ctx, bootstrapPath, bootstrapRequest{
		SchemaVersion: BootstrapSchemaVersion, BootstrapRequest: request,
	}, &response, http.StatusOK); err != nil {
		return recorderfleet.NodeIdentity{}, err
	}
	identity := response.Identity
	if response.SchemaVersion != BootstrapSchemaVersion || identity.ProviderID != request.ProviderID || identity.Role != request.Key.Role || identity.BootGeneration != request.BootGeneration {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	workerID, err := utilities.ParseID(identity.WorkerID)
	if err != nil || workerID.IsZero() {
		return recorderfleet.NodeIdentity{}, recorderfleet.ErrRoleFence
	}
	return identity, nil
}

func (c *Client) RevokeIdentity(ctx context.Context, identity recorderfleet.NodeIdentity) error {
	if c == nil || strings.TrimSpace(identity.ProviderID) == "" || identity.BootGeneration == 0 || identity.Role != workeridentity.RoleCapture && identity.Role != workeridentity.RoleRender {
		return recorderfleet.ErrRoleFence
	}
	workerID, err := utilities.ParseID(identity.WorkerID)
	if err != nil || workerID.IsZero() {
		return recorderfleet.ErrRoleFence
	}
	return c.doJSON(ctx, revokePath, revokeRequest{
		SchemaVersion: RevokeSchemaVersion, Identity: identity,
	}, nil, http.StatusNoContent)
}

func (c *Client) doJSON(ctx context.Context, path string, input any, output any, expectedStatus int) error {
	encoded, err := json.Marshal(input)
	if err != nil {
		return recorderfleet.ErrInvalidConfig
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(encoded))
	if err != nil {
		return recorderfleet.ErrInvalidConfig
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("recorder fleet issuer request: %w", recorderfleet.ErrProviderUnavailable)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseSize+1))
	if err != nil || len(responseBody) > maximumResponseSize {
		return fmt.Errorf("%w: invalid recorder fleet issuer response", recorderfleet.ErrProviderUnavailable)
	}
	if response.StatusCode != expectedStatus {
		return fmt.Errorf("%w: recorder fleet issuer status %d", recorderfleet.ErrProviderUnavailable, response.StatusCode)
	}
	if output == nil {
		if len(bytes.TrimSpace(responseBody)) != 0 {
			return fmt.Errorf("%w: invalid recorder fleet issuer response", recorderfleet.ErrProviderUnavailable)
		}
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("%w: invalid recorder fleet issuer response", recorderfleet.ErrProviderUnavailable)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("%w: invalid recorder fleet issuer response", recorderfleet.ErrProviderUnavailable)
	}
	return nil
}

type bootstrapRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.BootstrapRequest
}

type bootstrapResponse struct {
	SchemaVersion string                     `json:"schema_version"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type revokeRequest struct {
	SchemaVersion string                     `json:"schema_version"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type UnavailableAuthority struct{}

func (UnavailableAuthority) EnsureBootstrap(context.Context, recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	return recorderfleet.NodeIdentity{}, recorderfleet.ErrProviderUnavailable
}

func (UnavailableAuthority) RevokeIdentity(context.Context, recorderfleet.NodeIdentity) error {
	return recorderfleet.ErrProviderUnavailable
}

var (
	_ recorderfleet.BootstrapAuthority = (*Client)(nil)
	_ recorderfleet.BootstrapAuthority = UnavailableAuthority{}
)
