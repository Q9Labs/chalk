package integrations

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidProvider            = errors.New("invalid integration provider")
	ErrInvalidService             = errors.New("invalid integration service")
	ErrInvalidConnectionID        = errors.New("invalid integration connection id")
	ErrInvalidConnectionOwner     = errors.New("invalid integration connection owner")
	ErrConnectionAlreadyExists    = errors.New("integration connection already exists")
	ErrConnectionNotFound         = errors.New("integration connection not found")
	ErrConnectionNotActive        = errors.New("integration connection not active")
	ErrProviderUnavailable        = errors.New("integration provider unavailable")
	ErrProviderUnauthorized       = errors.New("integration provider unauthorized")
	ErrProviderRateLimited        = errors.New("integration provider rate limited")
	ErrActionNotAllowed           = errors.New("integration action not allowed")
	ErrConnectionAuthUnconfigured = errors.New("integration connection auth unconfigured")
)

type ProviderName string
type ServiceID string
type ActionID string
type ConnectionStatus string

const (
	ProviderComposio ProviderName = "composio"

	StatusPending  ConnectionStatus = "pending"
	StatusActive   ConnectionStatus = "active"
	StatusDisabled ConnectionStatus = "disabled"
	StatusRevoked  ConnectionStatus = "revoked"
	StatusExpired  ConnectionStatus = "expired"
	StatusFailed   ConnectionStatus = "failed"
)

type ServiceEntry struct {
	ID                    ServiceID
	Family                string
	DisplayName           string
	Provider              ProviderName
	ToolkitSlug           string
	ToolkitVersion        string
	ExternalAuthConfigRef *string
	AllowedActions        []ActionPolicy
	CapabilityTags        []string
	RiskTags              []string
	Enabled               bool
}

type ActionPolicy struct {
	ID             ActionID
	Slug           string
	DisplayName    string
	CapabilityTags []string
	RiskTags       []string
}

type Connection struct {
	ID                    utilities.ID
	TenantID              utilities.ID
	UserID                utilities.ID
	Provider              ProviderName
	Service               ServiceID
	ExternalAccountRef    string
	ExternalAuthConfigRef *string
	Status                ConnectionStatus
	AccountLabel          *string
	AccountEmail          *string
	Scopes                []string
	ConnectedAt           *time.Time
	ExpiresAt             *time.Time
	LastUsedAt            *time.Time
	RevokedAt             *time.Time
	UpdatedAt             time.Time
	CreatedAt             time.Time
}

type ConnectionList struct {
	Connections []Connection
	Page        pagination.Page
}

type StartConnectionInput struct {
	TenantID     utilities.ID
	UserID       utilities.ID
	Provider     ProviderName
	Service      ServiceID
	CallbackURL  *string
	AccountAlias *string
}

type StartConnectionResult struct {
	Connection Connection
	ConnectURL string
	ExpiresAt  *time.Time
}

type RefreshConnectionResult struct {
	Connection Connection
	ConnectURL string
}

type ExecuteActionInput struct {
	TenantID         utilities.ID
	OwnerScopeUserID utilities.ID
	ActorUserID      utilities.ID
	ActorType        string
	ConnectionID     utilities.ID
	Action           ActionID
	Arguments        map[string]any
	Text             *string
}

type ExecuteActionResult struct {
	Connection Connection
	Action     ActionPolicy
	Data       map[string]any
	LogID      string
}

type ListConnectionsInput struct {
	TenantID utilities.ID
	UserID   utilities.ID
	Provider ProviderName
	Service  ServiceID
	Status   ConnectionStatus
	Page     pagination.PageRequest
}

type UpdateConnectionInput struct {
	ID           utilities.ID
	TenantID     utilities.ID
	Status       ConnectionStatus
	AccountLabel *string
	AccountEmail *string
	Scopes       []string
	ConnectedAt  *time.Time
	ExpiresAt    *time.Time
	RevokedAt    *time.Time
}

type CreateConnectionInput struct {
	ID                    utilities.ID
	TenantID              utilities.ID
	UserID                utilities.ID
	Provider              ProviderName
	Service               ServiceID
	ExternalAccountRef    string
	ExternalAuthConfigRef *string
	Status                ConnectionStatus
	AccountLabel          *string
	AccountEmail          *string
	Scopes                []string
	ConnectedAt           *time.Time
	ExpiresAt             *time.Time
}

type AuditLogInput struct {
	ID          utilities.ID
	TenantID    utilities.ID
	ActorUserID utilities.ID
	ActorType   string
	Action      string
	ResourceID  utilities.ID
	Outcome     string
	ErrorCode   *string
}

type Repository interface {
	RunInTransaction(ctx context.Context, fn func(Repository) error) error
	CreateConnection(ctx context.Context, input CreateConnectionInput) (Connection, error)
	GetConnection(ctx context.Context, tenantID utilities.ID, id utilities.ID) (Connection, error)
	GetConnectionByExternalRef(ctx context.Context, tenantID utilities.ID, provider ProviderName, service ServiceID, externalAccountRef string) (Connection, error)
	ListConnections(ctx context.Context, input ListConnectionsInput) (ConnectionList, error)
	UpdateConnection(ctx context.Context, input UpdateConnectionInput) (Connection, error)
	MarkConnectionUsed(ctx context.Context, tenantID utilities.ID, id utilities.ID) (Connection, error)
	CreateAuditLog(ctx context.Context, input AuditLogInput) error
}

type Provider interface {
	CreateConnectLink(ctx context.Context, input CreateConnectLinkInput) (ConnectLink, error)
	GetConnection(ctx context.Context, input GetProviderConnectionInput) (ProviderConnection, error)
	RefreshConnection(ctx context.Context, input RefreshConnectionInput) (ProviderConnection, error)
	DisableConnection(ctx context.Context, input DisableConnectionInput) error
	ExecuteAction(ctx context.Context, input ExecuteProviderActionInput) (ProviderActionResult, error)
}

type CreateConnectLinkInput struct {
	UserID                utilities.ID
	Service               ServiceID
	ToolkitSlug           string
	ExternalAuthConfigRef *string
	CallbackURL           *string
	AccountAlias          *string
}

type ConnectLink struct {
	URL                   string
	ExternalAccountRef    string
	ExternalAuthConfigRef *string
	ExpiresAt             *time.Time
}

type GetProviderConnectionInput struct {
	ExternalAccountRef string
}

type RefreshConnectionInput struct {
	ExternalAccountRef string
}

type DisableConnectionInput struct {
	ExternalAccountRef string
	Revoke             bool
}

type ExecuteProviderActionInput struct {
	UserID             utilities.ID
	ExternalAccountRef string
	ToolkitSlug        string
	ActionSlug         string
	Version            string
	Arguments          map[string]any
	Text               *string
}

type ProviderActionResult struct {
	Data  map[string]any
	LogID string
}

type ProviderConnection struct {
	ExternalAccountRef    string
	ExternalAuthConfigRef *string
	ToolkitSlug           string
	Status                ConnectionStatus
	AccountLabel          *string
	AccountEmail          *string
	Scopes                []string
	ConnectedAt           *time.Time
	ExpiresAt             *time.Time
	RevokedAt             *time.Time
	RefreshURL            string
}
