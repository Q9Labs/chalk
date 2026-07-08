package composio

import "encoding/json"

type createConnectLinkRequest struct {
	AuthConfigID  string `json:"auth_config_id"`
	UserID        string `json:"user_id"`
	Alias         string `json:"alias,omitempty"`
	CallbackURL   string `json:"callback_url,omitempty"`
	AllowMultiple bool   `json:"allow_multiple"`
}

type createConnectLinkResponse struct {
	LinkToken          string `json:"link_token"`
	RedirectURL        string `json:"redirect_url"`
	ExpiresAt          string `json:"expires_at"`
	ConnectedAccountID string `json:"connected_account_id"`
}

type refreshConnectionResponse struct {
	RedirectURL string `json:"redirect_url"`
}

type connectedAccountStatusRequest struct {
	Enabled bool `json:"enabled"`
}

type executeToolRequest struct {
	ConnectedAccountID string          `json:"connected_account_id"`
	UserID             string          `json:"user_id"`
	Version            string          `json:"version,omitempty"`
	Arguments          *map[string]any `json:"arguments,omitempty"`
	Text               string          `json:"text,omitempty"`
}

type executeToolResponse struct {
	Data       map[string]any `json:"data"`
	Error      any            `json:"error"`
	Successful bool           `json:"successful"`
	LogID      string         `json:"log_id"`
}

type connectedAccountResponse struct {
	ID              string   `json:"id"`
	Alias           string   `json:"alias"`
	UserID          string   `json:"user_id"`
	Status          string   `json:"status"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
	StatusReason    string   `json:"status_reason"`
	IsDisabled      bool     `json:"is_disabled"`
	RequestedScopes []string `json:"requested_scopes"`
	Toolkit         struct {
		Slug string `json:"slug"`
	} `json:"toolkit"`
	AuthConfig struct {
		ID                string `json:"id"`
		AuthScheme        string `json:"auth_scheme"`
		IsComposioManaged bool   `json:"is_composio_managed"`
		IsDisabled        bool   `json:"is_disabled"`
	} `json:"auth_config"`
}

type listAuthConfigsResponse struct {
	Items []authConfigResponse `json:"items"`
}

type authConfigResponse struct {
	ID                 string `json:"id"`
	UUID               string `json:"uuid"`
	Name               string `json:"name"`
	AuthScheme         string `json:"auth_scheme"`
	IsComposioManaged  bool   `json:"is_composio_managed"`
	Status             string `json:"status"`
	IsEnabledForRouter bool   `json:"is_enabled_for_tool_router"`
	Toolkit            struct {
		Slug string `json:"slug"`
	} `json:"toolkit"`
}

type listToolkitsResponse struct {
	Items []toolkitResponse `json:"items"`
}

type toolkitResponse struct {
	Slug                       string          `json:"slug"`
	Name                       string          `json:"name"`
	AuthSchemes                []string        `json:"auth_schemes"`
	ComposioManagedAuthSchemes []string        `json:"composio_managed_auth_schemes"`
	NoAuth                     bool            `json:"no_auth"`
	Deprecated                 json.RawMessage `json:"deprecated"`
	Meta                       struct {
		Version       string `json:"version"`
		ToolsCount    int    `json:"tools_count"`
		TriggersCount int    `json:"triggers_count"`
	} `json:"meta"`
}

type listToolsResponse struct {
	Items []toolResponse `json:"items"`
}

type toolResponse struct {
	Slug             string          `json:"slug"`
	Name             string          `json:"name"`
	Description      string          `json:"description"`
	NoAuth           bool            `json:"no_auth"`
	Version          string          `json:"version"`
	AvailableVersion []string        `json:"available_versions"`
	Deprecated       json.RawMessage `json:"deprecated"`
	Scopes           []string        `json:"scopes"`
	InputParameters  map[string]any  `json:"input_parameters"`
	OutputParameters map[string]any  `json:"output_parameters"`
	Toolkit          struct {
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"toolkit"`
}

type requiredScopesRequest struct {
	Tools   []string `json:"tools"`
	Version string   `json:"version,omitempty"`
}

type requiredScopesResponse struct {
	ScopesRequired      []string `json:"scopes_required"`
	PerToolRequirements []struct {
		Tool              string         `json:"tool"`
		ScopeRequirements map[string]any `json:"scope_requirements"`
	} `json:"per_tool_requirements"`
}
