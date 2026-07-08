package composio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/integrations"
)

const DefaultBaseURL = "https://backend.composio.dev/api/v3.1"

var (
	ErrMissingAPIKey  = errors.New("missing composio api key")
	ErrInvalidBaseURL = errors.New("invalid composio base url")
)

type Config struct {
	APIKey         string
	BaseURL        string
	RequestTimeout time.Duration
	WebhookSecret  string
}

type Adapter struct {
	apiKey  string
	baseURL *url.URL
	client  *http.Client
}

type Toolkit struct {
	Slug               string
	Name               string
	ManagedAuthSchemes []string
	AuthSchemes        []string
	NoAuth             bool
	Deprecated         bool
	Version            string
	ToolsCount         int
	TriggersCount      int
}

type Tool struct {
	Slug             string
	Name             string
	ToolkitSlug      string
	Version          string
	NoAuth           bool
	Deprecated       bool
	Scopes           []string
	InputParameters  map[string]any
	OutputParameters map[string]any
}

type RequiredScopes struct {
	Scopes              []string
	PerToolRequirements []ToolScopeRequirement
}

type ToolScopeRequirement struct {
	Tool              string
	ScopeRequirements map[string]any
}

type authConfig struct {
	ID                 string
	ToolkitSlug        string
	Status             string
	IsComposioManaged  bool
	IsEnabledForRouter bool
}

func NewAdapter(cfg Config) (Adapter, error) {
	apiKey := strings.TrimSpace(cfg.APIKey)
	if apiKey == "" {
		return Adapter{}, ErrMissingAPIKey
	}

	baseURL := strings.TrimSpace(cfg.BaseURL)
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return Adapter{}, ErrInvalidBaseURL
	}

	timeout := cfg.RequestTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	return NewAdapterWithClient(apiKey, parsed, &http.Client{Timeout: timeout}), nil
}

func NewAdapterWithClient(apiKey string, baseURL *url.URL, client *http.Client) Adapter {
	return Adapter{
		apiKey:  strings.TrimSpace(apiKey),
		baseURL: cloneURL(baseURL),
		client:  client,
	}
}

func (a Adapter) CreateConnectLink(ctx context.Context, input integrations.CreateConnectLinkInput) (integrations.ConnectLink, error) {
	authConfigRef := stringValue(input.ExternalAuthConfigRef)
	if authConfigRef == "" {
		authConfig, err := a.managedAuthConfig(ctx, input.ToolkitSlug)
		if err != nil {
			return integrations.ConnectLink{}, err
		}
		authConfigRef = authConfig.ID
	}

	request := createConnectLinkRequest{
		AuthConfigID:  authConfigRef,
		UserID:        input.UserID.String(),
		Alias:         stringValue(input.AccountAlias),
		CallbackURL:   stringValue(input.CallbackURL),
		AllowMultiple: true,
	}
	var response createConnectLinkResponse
	if err := a.doWithStatuses(ctx, http.MethodPost, "/connected_accounts/link", nil, request, []int{http.StatusOK, http.StatusCreated}, &response); err != nil {
		return integrations.ConnectLink{}, err
	}

	expiresAt := parseOptionalTime(response.ExpiresAt)
	return integrations.ConnectLink{
		URL:                   strings.TrimSpace(response.RedirectURL),
		ExternalAccountRef:    strings.TrimSpace(response.ConnectedAccountID),
		ExternalAuthConfigRef: &authConfigRef,
		ExpiresAt:             expiresAt,
	}, nil
}

func (a Adapter) GetConnection(ctx context.Context, input integrations.GetProviderConnectionInput) (integrations.ProviderConnection, error) {
	var response connectedAccountResponse
	if err := a.do(ctx, http.MethodGet, "/connected_accounts/"+url.PathEscape(input.ExternalAccountRef), nil, nil, http.StatusOK, &response); err != nil {
		return integrations.ProviderConnection{}, err
	}
	return mapConnectedAccount(response), nil
}

func (a Adapter) RefreshConnection(ctx context.Context, input integrations.RefreshConnectionInput) (integrations.ProviderConnection, error) {
	path := "/connected_accounts/" + url.PathEscape(input.ExternalAccountRef) + "/refresh"
	var response refreshConnectionResponse
	if err := a.do(ctx, http.MethodPost, path, nil, map[string]any{}, http.StatusOK, &response); err != nil {
		return integrations.ProviderConnection{}, err
	}
	connection, err := a.GetConnection(ctx, integrations.GetProviderConnectionInput(input))
	if err != nil {
		return integrations.ProviderConnection{}, err
	}
	connection.RefreshURL = strings.TrimSpace(response.RedirectURL)
	return connection, nil
}

func (a Adapter) DisableConnection(ctx context.Context, input integrations.DisableConnectionInput) error {
	query := url.Values{}
	if input.Revoke {
		query.Set("revoke_on_delete", "true")
	}
	return a.do(ctx, http.MethodDelete, "/connected_accounts/"+url.PathEscape(input.ExternalAccountRef), query, nil, http.StatusOK, nil)
}

func (a Adapter) ExecuteAction(ctx context.Context, input integrations.ExecuteProviderActionInput) (integrations.ProviderActionResult, error) {
	arguments := input.Arguments
	var requestArguments *map[string]any
	if input.Text == nil {
		if arguments == nil {
			arguments = map[string]any{}
		}
		requestArguments = &arguments
	}

	request := executeToolRequest{
		ConnectedAccountID: strings.TrimSpace(input.ExternalAccountRef),
		UserID:             input.UserID.String(),
		Arguments:          requestArguments,
	}
	if input.Version != "" {
		request.Version = input.Version
	}
	if input.Text != nil {
		request.Text = strings.TrimSpace(*input.Text)
	}

	var response executeToolResponse
	path := "/tools/execute/" + url.PathEscape(input.ActionSlug)
	if err := a.do(ctx, http.MethodPost, path, nil, request, http.StatusOK, &response); err != nil {
		return integrations.ProviderActionResult{}, err
	}
	if !response.Successful {
		return integrations.ProviderActionResult{}, integrations.ErrProviderUnavailable
	}
	return integrations.ProviderActionResult{
		Data:  response.Data,
		LogID: strings.TrimSpace(response.LogID),
	}, nil
}

func (a Adapter) ListToolkits(ctx context.Context, slugs []string) ([]Toolkit, error) {
	if len(slugs) <= 1 {
		return a.listToolkits(ctx, slugs)
	}

	seen := make(map[string]bool, len(slugs))
	toolkits := make([]Toolkit, 0, len(slugs))
	for _, slug := range slugs {
		slug = strings.TrimSpace(slug)
		if slug == "" || seen[slug] {
			continue
		}
		seen[slug] = true

		matches, err := a.listToolkits(ctx, []string{slug})
		if err != nil {
			return nil, err
		}
		toolkits = append(toolkits, matches...)
	}
	return toolkits, nil
}

func (a Adapter) listToolkits(ctx context.Context, slugs []string) ([]Toolkit, error) {
	query := url.Values{}
	query.Set("limit", fmt.Sprintf("%d", max(1, len(slugs))))
	query.Set("include_deprecated", "false")
	if len(slugs) == 1 {
		query.Set("search", slugs[0])
	}

	var response listToolkitsResponse
	if err := a.do(ctx, http.MethodGet, "/toolkits", query, nil, http.StatusOK, &response); err != nil {
		return nil, err
	}

	wanted := make(map[string]bool, len(slugs))
	for _, slug := range slugs {
		wanted[slug] = true
	}

	toolkits := make([]Toolkit, 0, len(response.Items))
	for _, item := range response.Items {
		toolkit := mapToolkit(item)
		if len(wanted) == 0 || wanted[toolkit.Slug] {
			toolkits = append(toolkits, toolkit)
		}
	}
	return toolkits, nil
}

func (a Adapter) ListTools(ctx context.Context, toolkitSlug string, toolSlugs []string) ([]Tool, error) {
	query := url.Values{}
	query.Set("toolkit_slug", toolkitSlug)
	query.Set("toolkit_versions", "latest")
	query.Set("include_deprecated", "false")
	query.Set("limit", fmt.Sprintf("%d", max(1, len(toolSlugs))))
	if len(toolSlugs) > 0 {
		query.Set("tool_slugs", strings.Join(toolSlugs, ","))
	}

	var response listToolsResponse
	if err := a.do(ctx, http.MethodGet, "/tools", query, nil, http.StatusOK, &response); err != nil {
		return nil, err
	}

	tools := make([]Tool, 0, len(response.Items))
	for _, item := range response.Items {
		tools = append(tools, mapTool(item))
	}
	return tools, nil
}

func (a Adapter) RequiredScopes(ctx context.Context, toolSlugs []string, version string) (RequiredScopes, error) {
	request := requiredScopesRequest{Tools: toolSlugs}
	if strings.TrimSpace(version) != "" && version != "latest" {
		request.Version = version
	}

	var response requiredScopesResponse
	if err := a.do(ctx, http.MethodPost, "/tools/scopes/required", nil, request, http.StatusOK, &response); err != nil {
		return RequiredScopes{}, err
	}

	requirements := make([]ToolScopeRequirement, 0, len(response.PerToolRequirements))
	for _, item := range response.PerToolRequirements {
		requirements = append(requirements, ToolScopeRequirement{
			Tool:              item.Tool,
			ScopeRequirements: item.ScopeRequirements,
		})
	}

	return RequiredScopes{
		Scopes:              response.ScopesRequired,
		PerToolRequirements: requirements,
	}, nil
}

func (a Adapter) managedAuthConfig(ctx context.Context, toolkitSlug string) (authConfig, error) {
	query := url.Values{}
	query.Set("toolkit_slug", toolkitSlug)
	query.Set("is_composio_managed", "true")
	query.Set("show_disabled", "false")
	query.Set("limit", "10")

	var response listAuthConfigsResponse
	if err := a.do(ctx, http.MethodGet, "/auth_configs", query, nil, http.StatusOK, &response); err != nil {
		return authConfig{}, err
	}

	for _, item := range response.Items {
		config := mapAuthConfig(item)
		if config.ID != "" && config.Status == "ENABLED" {
			return config, nil
		}
	}
	return authConfig{}, integrations.ErrConnectionAuthUnconfigured
}

func (a Adapter) do(ctx context.Context, method string, path string, query url.Values, body any, wantStatus int, target any) error {
	return a.doWithStatuses(ctx, method, path, query, body, []int{wantStatus}, target)
}

func (a Adapter) doWithStatuses(ctx context.Context, method string, path string, query url.Values, body any, wantStatuses []int, target any) error {
	if a.client == nil || a.baseURL == nil || a.apiKey == "" {
		return integrations.ErrProviderUnavailable
	}

	requestURL := a.baseURL.ResolveReference(&url.URL{Path: strings.TrimRight(a.baseURL.Path, "/") + path})
	if len(query) > 0 {
		requestURL.RawQuery = query.Encode()
	}

	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode composio request: %w", err)
		}
		reader = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, requestURL.String(), reader)
	if err != nil {
		return fmt.Errorf("create composio request: %w", err)
	}
	req.Header.Set("x-api-key", a.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	res, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("send composio request: %w", errors.Join(integrations.ErrProviderUnavailable, err))
	}
	defer res.Body.Close()

	if !containsStatus(wantStatuses, res.StatusCode) {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		return mapStatusError(res.StatusCode)
	}
	if target == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(target); err != nil {
		return fmt.Errorf("decode composio response: %w", errors.Join(integrations.ErrProviderUnavailable, err))
	}

	return nil
}

func containsStatus(statuses []int, status int) bool {
	for _, candidate := range statuses {
		if candidate == status {
			return true
		}
	}
	return false
}

func mapStatusError(status int) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return integrations.ErrProviderUnauthorized
	case http.StatusTooManyRequests:
		return integrations.ErrProviderRateLimited
	case http.StatusRequestTimeout, http.StatusRequestEntityTooLarge, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return integrations.ErrProviderUnavailable
	case http.StatusNotFound:
		return integrations.ErrConnectionNotFound
	default:
		if status >= 500 {
			return integrations.ErrProviderUnavailable
		}
		return integrations.ErrProviderUnavailable
	}
}

func mapConnectedAccount(response connectedAccountResponse) integrations.ProviderConnection {
	status := mapProviderStatus(response.Status, response.IsDisabled)
	authConfigRef := strings.TrimSpace(response.AuthConfig.ID)
	return integrations.ProviderConnection{
		ExternalAccountRef:    strings.TrimSpace(response.ID),
		ExternalAuthConfigRef: nullableString(authConfigRef),
		ToolkitSlug:           strings.TrimSpace(response.Toolkit.Slug),
		Status:                status,
		AccountLabel:          nullableString(response.Alias),
		Scopes:                response.RequestedScopes,
		ConnectedAt:           parseOptionalTime(response.CreatedAt),
		RevokedAt:             revokedAt(status),
	}
}

func mapProviderStatus(status string, disabled bool) integrations.ConnectionStatus {
	if disabled {
		return integrations.StatusDisabled
	}

	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "ACTIVE", "ENABLED", "CONNECTED":
		return integrations.StatusActive
	case "EXPIRED":
		return integrations.StatusExpired
	case "FAILED", "ERROR":
		return integrations.StatusFailed
	case "REVOKED":
		return integrations.StatusRevoked
	default:
		return integrations.StatusPending
	}
}

func mapAuthConfig(item authConfigResponse) authConfig {
	return authConfig{
		ID:                 firstNonBlank(item.ID, item.UUID),
		ToolkitSlug:        item.Toolkit.Slug,
		Status:             strings.ToUpper(strings.TrimSpace(item.Status)),
		IsComposioManaged:  item.IsComposioManaged,
		IsEnabledForRouter: item.IsEnabledForRouter,
	}
}

func mapToolkit(item toolkitResponse) Toolkit {
	return Toolkit{
		Slug:               item.Slug,
		Name:               item.Name,
		ManagedAuthSchemes: item.ComposioManagedAuthSchemes,
		AuthSchemes:        item.AuthSchemes,
		NoAuth:             item.NoAuth,
		Deprecated:         deprecatedValue(item.Deprecated),
		Version:            item.Meta.Version,
		ToolsCount:         item.Meta.ToolsCount,
		TriggersCount:      item.Meta.TriggersCount,
	}
}

func mapTool(item toolResponse) Tool {
	return Tool{
		Slug:             item.Slug,
		Name:             item.Name,
		ToolkitSlug:      item.Toolkit.Slug,
		Version:          item.Version,
		NoAuth:           item.NoAuth,
		Deprecated:       deprecatedValue(item.Deprecated),
		Scopes:           item.Scopes,
		InputParameters:  item.InputParameters,
		OutputParameters: item.OutputParameters,
	}
}

func parseOptionalTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}

	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil
	}
	parsed = parsed.UTC()
	return &parsed
}

func revokedAt(status integrations.ConnectionStatus) *time.Time {
	if status != integrations.StatusRevoked {
		return nil
	}
	now := time.Now().UTC()
	return &now
}

func nullableString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func deprecatedValue(value []byte) bool {
	value = bytes.TrimSpace(value)
	if len(value) == 0 || bytes.Equal(value, []byte("null")) {
		return false
	}

	var deprecated bool
	if err := json.Unmarshal(value, &deprecated); err == nil {
		return deprecated
	}
	return false
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func cloneURL(value *url.URL) *url.URL {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

var _ integrations.Provider = Adapter{}
