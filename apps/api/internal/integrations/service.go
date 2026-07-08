package integrations

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	auditConnectionStarted   = "integration.connection.started"
	auditConnectionConnected = "integration.connection.connected"
	auditConnectionFailed    = "integration.connection.failed"
	auditConnectionDisabled  = "integration.connection.disabled"
	auditActionExecuted      = "integration.action.executed"

	auditActorUser = "user"
)

type Service struct {
	repository Repository
	provider   Provider
	catalog    Catalog
}

func NewService(repository Repository, provider Provider, catalog Catalog) Service {
	return Service{
		repository: repository,
		provider:   provider,
		catalog:    catalog,
	}
}

func (s Service) ListServices(ctx context.Context) ([]ServiceEntry, error) {
	return s.catalog.Services(), nil
}

func (s Service) StartConnection(ctx context.Context, input StartConnectionInput) (StartConnectionResult, error) {
	if err := validateConnectionOwner(input.TenantID, input.UserID); err != nil {
		return StartConnectionResult{}, err
	}
	if input.Provider != ProviderComposio {
		return StartConnectionResult{}, ErrInvalidProvider
	}

	entry, ok := s.catalog.Get(input.Service)
	if !ok {
		return StartConnectionResult{}, ErrInvalidService
	}
	if s.provider == nil {
		return StartConnectionResult{}, ErrProviderUnavailable
	}

	link, err := s.provider.CreateConnectLink(ctx, CreateConnectLinkInput{
		UserID:                input.UserID,
		Service:               entry.ID,
		ToolkitSlug:           entry.ToolkitSlug,
		ExternalAuthConfigRef: entry.ExternalAuthConfigRef,
		CallbackURL:           input.CallbackURL,
		AccountAlias:          input.AccountAlias,
	})
	if err != nil {
		return StartConnectionResult{}, err
	}
	if link.URL == "" || link.ExternalAccountRef == "" {
		return StartConnectionResult{}, ErrProviderUnavailable
	}
	existing, found, err := s.connectionByExternalRef(ctx, input.TenantID, entry.ID, link.ExternalAccountRef)
	if err != nil {
		return StartConnectionResult{}, err
	}
	if found {
		result, err := s.startExistingConnection(ctx, input.TenantID, input.UserID, existing, link)
		if err != nil {
			return StartConnectionResult{}, err
		}
		return result, nil
	}

	id, err := utilities.NewID()
	if err != nil {
		return StartConnectionResult{}, fmt.Errorf("generate integration connection id: %w", err)
	}

	connection, err := s.repository.CreateConnection(ctx, CreateConnectionInput{
		ID:                    id,
		TenantID:              input.TenantID,
		UserID:                input.UserID,
		Provider:              ProviderComposio,
		Service:               entry.ID,
		ExternalAccountRef:    link.ExternalAccountRef,
		ExternalAuthConfigRef: link.ExternalAuthConfigRef,
		Status:                StatusPending,
	})
	if errors.Is(err, ErrConnectionAlreadyExists) {
		existing, found, reuseErr := s.connectionByExternalRef(ctx, input.TenantID, entry.ID, link.ExternalAccountRef)
		if reuseErr != nil {
			return StartConnectionResult{}, reuseErr
		}
		if found {
			result, restartErr := s.startExistingConnection(ctx, input.TenantID, input.UserID, existing, link)
			if restartErr != nil {
				return StartConnectionResult{}, restartErr
			}
			return result, nil
		}
	}
	if err != nil {
		return StartConnectionResult{}, err
	}

	if err := s.audit(ctx, input.TenantID, input.UserID, auditActorUser, auditConnectionStarted, connection.ID, "success", nil); err != nil {
		return StartConnectionResult{}, err
	}

	return StartConnectionResult{
		Connection: connection,
		ConnectURL: link.URL,
		ExpiresAt:  link.ExpiresAt,
	}, nil
}

func (s Service) connectionByExternalRef(ctx context.Context, tenantID utilities.ID, serviceID ServiceID, externalAccountRef string) (Connection, bool, error) {
	connection, err := s.repository.GetConnectionByExternalRef(ctx, tenantID, ProviderComposio, serviceID, externalAccountRef)
	if errors.Is(err, ErrConnectionNotFound) {
		return Connection{}, false, nil
	}
	if err != nil {
		return Connection{}, false, err
	}
	return connection, true, nil
}

func (s Service) startExistingConnection(ctx context.Context, tenantID utilities.ID, userID utilities.ID, connection Connection, link ConnectLink) (StartConnectionResult, error) {
	if connection.UserID != userID {
		return StartConnectionResult{}, ErrConnectionAlreadyExists
	}
	switch connection.Status {
	case StatusPending, StatusActive:
		return StartConnectionResult{
			Connection: connection,
			ConnectURL: link.URL,
			ExpiresAt:  link.ExpiresAt,
		}, nil
	default:
		updated, err := s.repository.UpdateConnection(ctx, UpdateConnectionInput{
			ID:       connection.ID,
			TenantID: connection.TenantID,
			Status:   StatusPending,
		})
		if err != nil {
			return StartConnectionResult{}, err
		}
		if err := s.audit(ctx, tenantID, userID, auditActorUser, auditConnectionStarted, updated.ID, "success", nil); err != nil {
			return StartConnectionResult{}, err
		}
		return StartConnectionResult{
			Connection: updated,
			ConnectURL: link.URL,
			ExpiresAt:  link.ExpiresAt,
		}, nil
	}
}

func (s Service) ListConnections(ctx context.Context, input ListConnectionsInput) (ConnectionList, error) {
	if input.TenantID.IsZero() {
		return ConnectionList{}, ErrInvalidConnectionOwner
	}
	if input.Provider != "" && input.Provider != ProviderComposio {
		return ConnectionList{}, ErrInvalidProvider
	}
	if input.Service != "" {
		if _, ok := s.catalog.Get(input.Service); !ok {
			return ConnectionList{}, ErrInvalidService
		}
	}
	if input.Page.Size() == 0 {
		page, err := pagination.NewPageRequest(pagination.DefaultPageSize, nil)
		if err != nil {
			return ConnectionList{}, err
		}
		input.Page = page
	}

	return s.repository.ListConnections(ctx, input)
}

func (s Service) GetConnection(ctx context.Context, tenantID utilities.ID, actorUserID utilities.ID, id utilities.ID) (Connection, error) {
	if tenantID.IsZero() {
		return Connection{}, ErrInvalidConnectionOwner
	}
	if id.IsZero() {
		return Connection{}, ErrInvalidConnectionID
	}

	connection, err := s.repository.GetConnection(ctx, tenantID, id)
	if err != nil {
		return Connection{}, err
	}
	if !actorUserID.IsZero() && connection.UserID != actorUserID {
		return Connection{}, ErrConnectionNotFound
	}
	return connection, nil
}

func (s Service) RefreshConnection(ctx context.Context, tenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, id utilities.ID) (RefreshConnectionResult, error) {
	connection, err := s.GetConnection(ctx, tenantID, ownerScopeUserID, id)
	if err != nil {
		return RefreshConnectionResult{}, err
	}
	if s.provider == nil {
		return RefreshConnectionResult{}, ErrProviderUnavailable
	}

	providerConnection, err := s.provider.RefreshConnection(ctx, RefreshConnectionInput{
		ExternalAccountRef: connection.ExternalAccountRef,
	})
	if err != nil {
		code := providerErrorCode(err)
		auditErr := s.audit(ctx, tenantID, actorUserID, actorType, auditConnectionFailed, connection.ID, "failure", &code)
		if auditErr != nil {
			return RefreshConnectionResult{}, auditErr
		}
		return RefreshConnectionResult{}, err
	}

	updated, err := s.repository.UpdateConnection(ctx, updateInputFromProvider(connection, providerConnection))
	if err != nil {
		return RefreshConnectionResult{}, err
	}

	action := auditConnectionConnected
	outcome := "success"
	var errorCode *string
	if updated.Status != StatusActive {
		action = auditConnectionFailed
		outcome = "failure"
		code := "integration_connection_not_active"
		errorCode = &code
	}
	if err := s.audit(ctx, tenantID, actorUserID, actorType, action, connection.ID, outcome, errorCode); err != nil {
		return RefreshConnectionResult{}, err
	}
	return RefreshConnectionResult{
		Connection: updated,
		ConnectURL: providerConnection.RefreshURL,
	}, nil
}

func (s Service) DisableConnection(ctx context.Context, tenantID utilities.ID, ownerScopeUserID utilities.ID, actorUserID utilities.ID, actorType string, id utilities.ID, revoke bool) (Connection, error) {
	connection, err := s.GetConnection(ctx, tenantID, ownerScopeUserID, id)
	if err != nil {
		return Connection{}, err
	}
	if s.provider == nil {
		return Connection{}, ErrProviderUnavailable
	}

	if err := s.provider.DisableConnection(ctx, DisableConnectionInput{
		ExternalAccountRef: connection.ExternalAccountRef,
		Revoke:             revoke,
	}); err != nil {
		if !errors.Is(err, ErrConnectionNotFound) {
			return Connection{}, err
		}
	}

	status := StatusDisabled
	var revokedAt *time.Time
	if revoke {
		now := time.Now().UTC()
		status = StatusRevoked
		revokedAt = &now
	}
	updated, err := s.repository.UpdateConnection(ctx, UpdateConnectionInput{
		ID:           connection.ID,
		TenantID:     connection.TenantID,
		Status:       status,
		AccountLabel: connection.AccountLabel,
		AccountEmail: connection.AccountEmail,
		Scopes:       connection.Scopes,
		ConnectedAt:  connection.ConnectedAt,
		ExpiresAt:    connection.ExpiresAt,
		RevokedAt:    revokedAt,
	})
	if err != nil {
		return Connection{}, err
	}

	if err := s.audit(ctx, tenantID, actorUserID, actorType, auditConnectionDisabled, connection.ID, "success", nil); err != nil {
		return Connection{}, err
	}
	return updated, nil
}

func (s Service) ExecuteAction(ctx context.Context, input ExecuteActionInput) (ExecuteActionResult, error) {
	connection, err := s.GetConnection(ctx, input.TenantID, input.OwnerScopeUserID, input.ConnectionID)
	if err != nil {
		return ExecuteActionResult{}, err
	}
	if connection.Status != StatusActive {
		return ExecuteActionResult{}, ErrConnectionNotActive
	}
	if s.provider == nil {
		return ExecuteActionResult{}, ErrProviderUnavailable
	}

	entry, ok := s.catalog.Get(connection.Service)
	if !ok {
		return ExecuteActionResult{}, ErrInvalidService
	}
	action, ok := allowedAction(entry, input.Action)
	if !ok {
		return ExecuteActionResult{}, ErrActionNotAllowed
	}

	result, err := s.provider.ExecuteAction(ctx, ExecuteProviderActionInput{
		UserID:             connection.UserID,
		ExternalAccountRef: connection.ExternalAccountRef,
		ToolkitSlug:        entry.ToolkitSlug,
		ActionSlug:         action.Slug,
		Version:            entry.ToolkitVersion,
		Arguments:          input.Arguments,
		Text:               input.Text,
	})
	if err != nil {
		code := providerErrorCode(err)
		auditErr := s.audit(ctx, input.TenantID, input.ActorUserID, input.ActorType, auditActionExecuted, connection.ID, "failure", &code)
		if auditErr != nil {
			return ExecuteActionResult{}, auditErr
		}
		return ExecuteActionResult{}, err
	}

	used := connection
	if marked, err := s.repository.MarkConnectionUsed(ctx, connection.TenantID, connection.ID); err == nil {
		used = marked
	}
	// The provider action may already have external side effects. Do not turn
	// best-effort local bookkeeping failures into retryable execution errors.
	_ = s.audit(ctx, input.TenantID, input.ActorUserID, input.ActorType, auditActionExecuted, connection.ID, "success", nil)

	return ExecuteActionResult{
		Connection: used,
		Action:     action,
		Data:       result.Data,
		LogID:      result.LogID,
	}, nil
}

func validateConnectionOwner(tenantID utilities.ID, userID utilities.ID) error {
	if tenantID.IsZero() || userID.IsZero() {
		return ErrInvalidConnectionOwner
	}
	return nil
}

func updateInputFromProvider(connection Connection, provider ProviderConnection) UpdateConnectionInput {
	status := provider.Status
	if status == "" {
		status = connection.Status
	}
	return UpdateConnectionInput{
		ID:           connection.ID,
		TenantID:     connection.TenantID,
		Status:       status,
		AccountLabel: provider.AccountLabel,
		AccountEmail: provider.AccountEmail,
		Scopes:       provider.Scopes,
		ConnectedAt:  provider.ConnectedAt,
		ExpiresAt:    provider.ExpiresAt,
		RevokedAt:    provider.RevokedAt,
	}
}

func allowedAction(entry ServiceEntry, id ActionID) (ActionPolicy, bool) {
	for _, action := range entry.AllowedActions {
		if action.ID == id {
			return action, true
		}
	}
	return ActionPolicy{}, false
}

func (s Service) audit(ctx context.Context, tenantID utilities.ID, actorUserID utilities.ID, actorType string, action string, resourceID utilities.ID, outcome string, errorCode *string) error {
	id, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("generate integration audit id: %w", err)
	}
	if actorType == "" {
		actorType = auditActorUser
	}

	return s.repository.CreateAuditLog(ctx, AuditLogInput{
		ID:          id,
		TenantID:    tenantID,
		ActorUserID: actorUserID,
		ActorType:   actorType,
		Action:      action,
		ResourceID:  resourceID,
		Outcome:     outcome,
		ErrorCode:   errorCode,
	})
}

func providerErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrProviderUnauthorized):
		return "integration_provider_unauthorized"
	case errors.Is(err, ErrProviderRateLimited):
		return "integration_provider_rate_limited"
	default:
		return "integration_provider_unavailable"
	}
}
