package integrations

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type repository struct {
	runInTransaction           func(context.Context, func(Repository) error) error
	createConnection           func(context.Context, CreateConnectionInput) (Connection, error)
	getConnection              func(context.Context, utilities.ID, utilities.ID) (Connection, error)
	getConnectionByExternalRef func(context.Context, utilities.ID, ProviderName, ServiceID, string) (Connection, error)
	listConnections            func(context.Context, ListConnectionsInput) (ConnectionList, error)
	updateConnection           func(context.Context, UpdateConnectionInput) (Connection, error)
	markConnectionUsed         func(context.Context, utilities.ID, utilities.ID) (Connection, error)
	createAuditLog             func(context.Context, AuditLogInput) error
}

type provider struct {
	createConnectLink func(context.Context, CreateConnectLinkInput) (ConnectLink, error)
	refreshConnection func(context.Context, RefreshConnectionInput) (ProviderConnection, error)
	disableConnection func(context.Context, DisableConnectionInput) error
	executeAction     func(context.Context, ExecuteProviderActionInput) (ProviderActionResult, error)
}

func (r repository) RunInTransaction(ctx context.Context, fn func(Repository) error) error {
	if r.runInTransaction != nil {
		return r.runInTransaction(ctx, fn)
	}
	return fn(r)
}

func (r repository) CreateConnection(ctx context.Context, input CreateConnectionInput) (Connection, error) {
	if r.createConnection == nil {
		return Connection{}, errors.New("unexpected create connection")
	}
	return r.createConnection(ctx, input)
}

func (r repository) GetConnection(ctx context.Context, tenantID utilities.ID, id utilities.ID) (Connection, error) {
	if r.getConnection == nil {
		return Connection{}, errors.New("unexpected get connection")
	}
	return r.getConnection(ctx, tenantID, id)
}

func (r repository) GetConnectionByExternalRef(ctx context.Context, tenantID utilities.ID, provider ProviderName, service ServiceID, externalAccountRef string) (Connection, error) {
	if r.getConnectionByExternalRef != nil {
		return r.getConnectionByExternalRef(ctx, tenantID, provider, service, externalAccountRef)
	}
	return Connection{}, errors.New("unexpected get connection by external ref")
}

func (r repository) ListConnections(ctx context.Context, input ListConnectionsInput) (ConnectionList, error) {
	if r.listConnections == nil {
		return ConnectionList{}, errors.New("unexpected list connections")
	}
	return r.listConnections(ctx, input)
}

func (r repository) UpdateConnection(ctx context.Context, input UpdateConnectionInput) (Connection, error) {
	if r.updateConnection == nil {
		return Connection{}, errors.New("unexpected update connection")
	}
	return r.updateConnection(ctx, input)
}

func (r repository) MarkConnectionUsed(ctx context.Context, tenantID utilities.ID, id utilities.ID) (Connection, error) {
	if r.markConnectionUsed != nil {
		return r.markConnectionUsed(ctx, tenantID, id)
	}
	return Connection{}, errors.New("unexpected mark used")
}

func (r repository) CreateAuditLog(ctx context.Context, input AuditLogInput) error {
	if r.createAuditLog == nil {
		return errors.New("unexpected create audit log")
	}
	return r.createAuditLog(ctx, input)
}

func (p provider) CreateConnectLink(ctx context.Context, input CreateConnectLinkInput) (ConnectLink, error) {
	if p.createConnectLink == nil {
		return ConnectLink{}, errors.New("unexpected create connect link")
	}
	return p.createConnectLink(ctx, input)
}

func (p provider) GetConnection(context.Context, GetProviderConnectionInput) (ProviderConnection, error) {
	return ProviderConnection{}, errors.New("unexpected get provider connection")
}

func (p provider) RefreshConnection(ctx context.Context, input RefreshConnectionInput) (ProviderConnection, error) {
	if p.refreshConnection == nil {
		return ProviderConnection{}, errors.New("unexpected refresh connection")
	}
	return p.refreshConnection(ctx, input)
}

func (p provider) DisableConnection(ctx context.Context, input DisableConnectionInput) error {
	if p.disableConnection == nil {
		return errors.New("unexpected disable connection")
	}
	return p.disableConnection(ctx, input)
}

func (p provider) ExecuteAction(ctx context.Context, input ExecuteProviderActionInput) (ProviderActionResult, error) {
	if p.executeAction == nil {
		return ProviderActionResult{}, errors.New("unexpected execute action")
	}
	return p.executeAction(ctx, input)
}

func TestStartConnectionCreatesPendingConnectionAndAudit(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	expiresAt := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	catalog := catalogForTest(t)
	auditCalled := false

	service := NewService(repository{
		getConnectionByExternalRef: func(context.Context, utilities.ID, ProviderName, ServiceID, string) (Connection, error) {
			return Connection{}, ErrConnectionNotFound
		},
		createConnection: func(ctx context.Context, input CreateConnectionInput) (Connection, error) {
			if input.TenantID != tenantID || input.UserID != userID {
				t.Fatalf("owner = %s/%s", input.TenantID.String(), input.UserID.String())
			}
			if input.Provider != ProviderComposio || input.Service != "slack" {
				t.Fatalf("provider/service = %s/%s", input.Provider, input.Service)
			}
			if input.ExternalAccountRef != "ca_test" {
				t.Fatalf("external account ref = %q, want ca_test", input.ExternalAccountRef)
			}
			if input.Status != StatusPending {
				t.Fatalf("status = %q, want pending", input.Status)
			}
			return Connection{
				ID:                 input.ID,
				TenantID:           input.TenantID,
				UserID:             input.UserID,
				Provider:           input.Provider,
				Service:            input.Service,
				ExternalAccountRef: input.ExternalAccountRef,
				Status:             input.Status,
			}, nil
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			auditCalled = true
			if input.Action != auditConnectionStarted || input.Outcome != "success" {
				t.Fatalf("audit = %s/%s", input.Action, input.Outcome)
			}
			return nil
		},
	}, provider{
		createConnectLink: func(ctx context.Context, input CreateConnectLinkInput) (ConnectLink, error) {
			if input.UserID != userID || input.ToolkitSlug != "slack" {
				t.Fatalf("provider input = %s/%s", input.UserID.String(), input.ToolkitSlug)
			}
			return ConnectLink{
				URL:                "https://composio.test/connect",
				ExternalAccountRef: "ca_test",
				ExpiresAt:          &expiresAt,
			}, nil
		},
	}, catalog)

	result, err := service.StartConnection(context.Background(), StartConnectionInput{
		TenantID: tenantID,
		UserID:   userID,
		Provider: ProviderComposio,
		Service:  "slack",
	})
	if err != nil {
		t.Fatalf("start connection: %v", err)
	}
	if result.ConnectURL != "https://composio.test/connect" {
		t.Fatalf("connect url = %q, want provider url", result.ConnectURL)
	}
	if result.Connection.Status != StatusPending {
		t.Fatalf("connection status = %q, want pending", result.Connection.Status)
	}
	if !auditCalled {
		t.Fatal("audit was not written")
	}
}

func TestStartConnectionCreatesConnectionAndAuditInTransaction(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	transactionCalled := false
	auditErr := errors.New("audit failed")

	service := NewService(repository{
		getConnectionByExternalRef: func(context.Context, utilities.ID, ProviderName, ServiceID, string) (Connection, error) {
			return Connection{}, ErrConnectionNotFound
		},
		runInTransaction: func(ctx context.Context, fn func(Repository) error) error {
			transactionCalled = true
			return fn(repository{
				createConnection: func(ctx context.Context, input CreateConnectionInput) (Connection, error) {
					return Connection{
						ID:                 input.ID,
						TenantID:           input.TenantID,
						UserID:             input.UserID,
						Provider:           input.Provider,
						Service:            input.Service,
						ExternalAccountRef: input.ExternalAccountRef,
						Status:             input.Status,
					}, nil
				},
				createAuditLog: func(context.Context, AuditLogInput) error {
					return auditErr
				},
			})
		},
	}, provider{
		createConnectLink: func(context.Context, CreateConnectLinkInput) (ConnectLink, error) {
			return ConnectLink{
				URL:                "https://composio.test/connect",
				ExternalAccountRef: "ca_test",
			}, nil
		},
	}, catalogForTest(t))

	_, err := service.StartConnection(context.Background(), StartConnectionInput{
		TenantID: tenantID,
		UserID:   userID,
		Provider: ProviderComposio,
		Service:  "slack",
	})
	if !errors.Is(err, auditErr) {
		t.Fatalf("error = %v, want audit error", err)
	}
	if !transactionCalled {
		t.Fatal("transaction was not used")
	}
}

func TestStartConnectionReusesExistingPendingProviderAccount(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	createCalled := false
	service := NewService(repository{
		getConnectionByExternalRef: func(ctx context.Context, gotTenantID utilities.ID, provider ProviderName, service ServiceID, externalAccountRef string) (Connection, error) {
			if gotTenantID != tenantID || provider != ProviderComposio || service != "slack" || externalAccountRef != "ca_test" {
				t.Fatalf("lookup = %s/%s/%s/%s", gotTenantID.String(), provider, service, externalAccountRef)
			}
			return Connection{
				ID:                 connectionID,
				TenantID:           tenantID,
				UserID:             userID,
				Provider:           ProviderComposio,
				Service:            "slack",
				ExternalAccountRef: "ca_test",
				Status:             StatusPending,
			}, nil
		},
		createConnection: func(context.Context, CreateConnectionInput) (Connection, error) {
			createCalled = true
			return Connection{}, nil
		},
	}, provider{
		createConnectLink: func(context.Context, CreateConnectLinkInput) (ConnectLink, error) {
			return ConnectLink{
				URL:                "https://composio.test/connect",
				ExternalAccountRef: "ca_test",
			}, nil
		},
	}, catalogForTest(t))

	result, err := service.StartConnection(context.Background(), StartConnectionInput{
		TenantID: tenantID,
		UserID:   userID,
		Provider: ProviderComposio,
		Service:  "slack",
	})
	if err != nil {
		t.Fatalf("start connection: %v", err)
	}
	if result.Connection.ID != connectionID || result.ConnectURL != "https://composio.test/connect" {
		t.Fatalf("result = %#v", result)
	}
	if createCalled {
		t.Fatal("create connection was called for reusable provider account")
	}
}

func TestStartConnectionRestartsExistingNonActiveProviderAccount(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	auditCalled := false
	service := NewService(repository{
		getConnectionByExternalRef: func(ctx context.Context, gotTenantID utilities.ID, provider ProviderName, service ServiceID, externalAccountRef string) (Connection, error) {
			if gotTenantID != tenantID || provider != ProviderComposio || service != "slack" || externalAccountRef != "ca_test" {
				t.Fatalf("lookup = %s/%s/%s/%s", gotTenantID.String(), provider, service, externalAccountRef)
			}
			return Connection{
				ID:                 connectionID,
				TenantID:           tenantID,
				UserID:             userID,
				Provider:           ProviderComposio,
				Service:            "slack",
				ExternalAccountRef: "ca_test",
				Status:             StatusDisabled,
			}, nil
		},
		updateConnection: func(ctx context.Context, input UpdateConnectionInput) (Connection, error) {
			if input.ID != connectionID || input.TenantID != tenantID {
				t.Fatalf("update target = %s/%s", input.TenantID.String(), input.ID.String())
			}
			if input.Status != StatusPending {
				t.Fatalf("status = %s, want pending", input.Status)
			}
			return Connection{
				ID:                 input.ID,
				TenantID:           input.TenantID,
				UserID:             userID,
				Provider:           ProviderComposio,
				Service:            "slack",
				ExternalAccountRef: "ca_test",
				Status:             input.Status,
			}, nil
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			auditCalled = true
			if input.ActorUserID != userID {
				t.Fatalf("audit actor = %s, want reconnecting user", input.ActorUserID.String())
			}
			if input.Action != auditConnectionStarted || input.Outcome != "success" {
				t.Fatalf("audit = %s/%s", input.Action, input.Outcome)
			}
			return nil
		},
	}, provider{
		createConnectLink: func(context.Context, CreateConnectLinkInput) (ConnectLink, error) {
			return ConnectLink{
				URL:                "https://composio.test/connect",
				ExternalAccountRef: "ca_test",
			}, nil
		},
	}, catalogForTest(t))

	result, err := service.StartConnection(context.Background(), StartConnectionInput{
		TenantID: tenantID,
		UserID:   userID,
		Provider: ProviderComposio,
		Service:  "slack",
	})
	if err != nil {
		t.Fatalf("start connection: %v", err)
	}
	if result.Connection.ID != connectionID || result.Connection.Status != StatusPending {
		t.Fatalf("connection = %#v, want restarted pending connection", result.Connection)
	}
	if !auditCalled {
		t.Fatal("audit was not written")
	}
}

func TestStartConnectionRejectsInvalidService(t *testing.T) {
	service := NewService(repository{}, provider{}, catalogForTest(t))

	_, err := service.StartConnection(context.Background(), StartConnectionInput{
		TenantID: mustID(t, "11111111-1111-4111-8111-111111111111"),
		UserID:   mustID(t, "22222222-2222-4222-8222-222222222222"),
		Provider: ProviderComposio,
		Service:  "unknown",
	})
	if !errors.Is(err, ErrInvalidService) {
		t.Fatalf("error = %v, want invalid service", err)
	}
}

func TestListConnectionsDefaultsPage(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	service := NewService(repository{
		listConnections: func(ctx context.Context, input ListConnectionsInput) (ConnectionList, error) {
			if input.Page.Size() != pagination.DefaultPageSize {
				t.Fatalf("page size = %d, want default", input.Page.Size())
			}
			return ConnectionList{}, nil
		},
	}, provider{}, catalogForTest(t))

	_, err := service.ListConnections(context.Background(), ListConnectionsInput{TenantID: tenantID})
	if err != nil {
		t.Fatalf("list connections: %v", err)
	}
}

func TestGetConnectionRejectsDifferentUserOwner(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	actorUserID := mustID(t, "22222222-2222-4222-8222-222222222222")
	ownerUserID := mustID(t, "44444444-4444-4444-8444-444444444444")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:       gotID,
				TenantID: gotTenantID,
				UserID:   ownerUserID,
			}, nil
		},
	}, provider{}, catalogForTest(t))

	_, err := service.GetConnection(context.Background(), tenantID, actorUserID, connectionID)
	if !errors.Is(err, ErrConnectionNotFound) {
		t.Fatalf("error = %v, want connection not found", err)
	}
}

func TestGetConnectionAllowsTenantScopedActorWithoutUserOwner(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	ownerUserID := mustID(t, "44444444-4444-4444-8444-444444444444")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:       gotID,
				TenantID: gotTenantID,
				UserID:   ownerUserID,
			}, nil
		},
	}, provider{}, catalogForTest(t))

	connection, err := service.GetConnection(context.Background(), tenantID, utilities.ID{}, connectionID)
	if err != nil {
		t.Fatalf("get connection: %v", err)
	}
	if connection.UserID != ownerUserID {
		t.Fatalf("owner = %s, want %s", connection.UserID.String(), ownerUserID.String())
	}
}

func TestRefreshConnectionAuditsProviderFailure(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	auditCalled := false
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:                 connectionID,
				TenantID:           gotTenantID,
				UserID:             userID,
				ExternalAccountRef: "ca_test",
			}, nil
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			auditCalled = true
			if input.ActorUserID != userID {
				t.Fatalf("audit actor = %s, want authenticated actor", input.ActorUserID.String())
			}
			if input.Outcome != "failure" || input.ErrorCode == nil || *input.ErrorCode != "integration_provider_rate_limited" {
				t.Fatalf("audit failure = %s/%v", input.Outcome, input.ErrorCode)
			}
			return nil
		},
	}, provider{
		refreshConnection: func(context.Context, RefreshConnectionInput) (ProviderConnection, error) {
			return ProviderConnection{}, ErrProviderRateLimited
		},
	}, catalogForTest(t))

	_, err := service.RefreshConnection(context.Background(), tenantID, utilities.ID{}, userID, auditActorUser, connectionID)
	if !errors.Is(err, ErrProviderRateLimited) {
		t.Fatalf("error = %v, want provider rate limited", err)
	}
	if !auditCalled {
		t.Fatal("audit was not written")
	}
}

func TestRefreshConnectionReturnsProviderConnectURL(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:                 gotID,
				TenantID:           gotTenantID,
				UserID:             userID,
				ExternalAccountRef: "ca_test",
				Status:             StatusExpired,
			}, nil
		},
		updateConnection: func(ctx context.Context, input UpdateConnectionInput) (Connection, error) {
			if input.Status != StatusActive {
				t.Fatalf("status = %s, want active", input.Status)
			}
			return Connection{
				ID:                 input.ID,
				TenantID:           input.TenantID,
				UserID:             userID,
				ExternalAccountRef: "ca_test",
				Status:             input.Status,
			}, nil
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			if input.Action != auditConnectionConnected || input.Outcome != "success" {
				t.Fatalf("audit = %s/%s", input.Action, input.Outcome)
			}
			return nil
		},
	}, provider{
		refreshConnection: func(ctx context.Context, input RefreshConnectionInput) (ProviderConnection, error) {
			if input.ExternalAccountRef != "ca_test" {
				t.Fatalf("external account ref = %q, want ca_test", input.ExternalAccountRef)
			}
			return ProviderConnection{
				ExternalAccountRef: "ca_test",
				Status:             StatusActive,
				RefreshURL:         "https://composio.test/reauth",
			}, nil
		},
	}, catalogForTest(t))

	result, err := service.RefreshConnection(context.Background(), tenantID, userID, userID, auditActorUser, connectionID)
	if err != nil {
		t.Fatalf("refresh connection: %v", err)
	}
	if result.ConnectURL != "https://composio.test/reauth" {
		t.Fatalf("connect url = %q, want provider refresh URL", result.ConnectURL)
	}
	if result.Connection.Status != StatusActive {
		t.Fatalf("status = %s, want active", result.Connection.Status)
	}
}

func TestRefreshConnectionAuditsNonActiveProviderStatusAsFailure(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:                 gotID,
				TenantID:           gotTenantID,
				UserID:             userID,
				ExternalAccountRef: "ca_test",
				Status:             StatusExpired,
			}, nil
		},
		updateConnection: func(ctx context.Context, input UpdateConnectionInput) (Connection, error) {
			if input.Status != StatusExpired {
				t.Fatalf("status = %s, want expired", input.Status)
			}
			return Connection{
				ID:                 input.ID,
				TenantID:           input.TenantID,
				UserID:             userID,
				ExternalAccountRef: "ca_test",
				Status:             input.Status,
			}, nil
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			if input.Action != auditConnectionFailed || input.Outcome != "failure" {
				t.Fatalf("audit = %s/%s", input.Action, input.Outcome)
			}
			if input.ErrorCode == nil || *input.ErrorCode != "integration_connection_not_active" {
				t.Fatalf("error code = %v, want non-active code", input.ErrorCode)
			}
			return nil
		},
	}, provider{
		refreshConnection: func(ctx context.Context, input RefreshConnectionInput) (ProviderConnection, error) {
			return ProviderConnection{
				ExternalAccountRef: "ca_test",
				Status:             StatusExpired,
				RefreshURL:         "https://composio.test/reauth",
			}, nil
		},
	}, catalogForTest(t))

	result, err := service.RefreshConnection(context.Background(), tenantID, userID, userID, auditActorUser, connectionID)
	if err != nil {
		t.Fatalf("refresh connection: %v", err)
	}
	if result.ConnectURL != "https://composio.test/reauth" {
		t.Fatalf("connect url = %q, want provider refresh URL", result.ConnectURL)
	}
	if result.Connection.Status != StatusExpired {
		t.Fatalf("status = %s, want expired", result.Connection.Status)
	}
}

func TestDisableConnectionDoesNotSetRevokedAtForSoftDisable(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:                 gotID,
				TenantID:           gotTenantID,
				UserID:             userID,
				ExternalAccountRef: "ca_test",
				Status:             StatusActive,
			}, nil
		},
		updateConnection: func(ctx context.Context, input UpdateConnectionInput) (Connection, error) {
			if input.Status != StatusDisabled {
				t.Fatalf("status = %s, want disabled", input.Status)
			}
			if input.RevokedAt != nil {
				t.Fatalf("revoked at = %v, want nil", input.RevokedAt)
			}
			return Connection{
				ID:       input.ID,
				TenantID: input.TenantID,
				UserID:   userID,
				Status:   input.Status,
			}, nil
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			if input.Action != auditConnectionDisabled || input.Outcome != "success" {
				t.Fatalf("audit = %s/%s", input.Action, input.Outcome)
			}
			return nil
		},
	}, provider{
		disableConnection: func(ctx context.Context, input DisableConnectionInput) error {
			if input.Revoke {
				t.Fatal("revoke = true, want false")
			}
			return nil
		},
	}, catalogForTest(t))

	connection, err := service.DisableConnection(context.Background(), tenantID, userID, userID, auditActorUser, connectionID, false)
	if err != nil {
		t.Fatalf("disable connection: %v", err)
	}
	if connection.Status != StatusDisabled {
		t.Fatalf("status = %s, want disabled", connection.Status)
	}
}

func TestDisableConnectionClearsLocalRowWhenProviderConnectionIsGone(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:                 gotID,
				TenantID:           gotTenantID,
				UserID:             userID,
				ExternalAccountRef: "ca_deleted",
				Status:             StatusActive,
			}, nil
		},
		updateConnection: func(ctx context.Context, input UpdateConnectionInput) (Connection, error) {
			if input.Status != StatusRevoked {
				t.Fatalf("status = %s, want revoked", input.Status)
			}
			if input.RevokedAt == nil {
				t.Fatal("revoked at = nil, want timestamp")
			}
			return Connection{
				ID:        input.ID,
				TenantID:  input.TenantID,
				UserID:    userID,
				Status:    input.Status,
				RevokedAt: input.RevokedAt,
			}, nil
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			if input.Action != auditConnectionDisabled || input.Outcome != "success" {
				t.Fatalf("audit = %s/%s", input.Action, input.Outcome)
			}
			return nil
		},
	}, provider{
		disableConnection: func(ctx context.Context, input DisableConnectionInput) error {
			if input.ExternalAccountRef != "ca_deleted" {
				t.Fatalf("external account ref = %q, want ca_deleted", input.ExternalAccountRef)
			}
			if !input.Revoke {
				t.Fatal("revoke = false, want true")
			}
			return ErrConnectionNotFound
		},
	}, catalogForTest(t))

	connection, err := service.DisableConnection(context.Background(), tenantID, userID, userID, auditActorUser, connectionID, true)
	if err != nil {
		t.Fatalf("disable connection: %v", err)
	}
	if connection.Status != StatusRevoked {
		t.Fatalf("status = %s, want revoked", connection.Status)
	}
	if connection.RevokedAt == nil {
		t.Fatal("revoked at = nil, want timestamp")
	}
}

func TestExecuteActionCallsProviderAndMarksConnectionUsed(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	auditCalled := false
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			if gotTenantID != tenantID || gotID != connectionID {
				t.Fatalf("lookup = %s/%s", gotTenantID.String(), gotID.String())
			}
			return Connection{
				ID:                 connectionID,
				TenantID:           tenantID,
				UserID:             userID,
				Provider:           ProviderComposio,
				Service:            "slack",
				ExternalAccountRef: "ca_slack",
				Status:             StatusActive,
			}, nil
		},
		markConnectionUsed: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			if gotTenantID != tenantID || gotID != connectionID {
				t.Fatalf("mark used = %s/%s", gotTenantID.String(), gotID.String())
			}
			return Connection{
				ID:       connectionID,
				TenantID: tenantID,
				UserID:   userID,
				Provider: ProviderComposio,
				Service:  "slack",
				Status:   StatusActive,
			}, nil
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			auditCalled = true
			if input.ActorUserID != userID || input.ActorType != auditActorUser {
				t.Fatalf("audit actor = %s/%s", input.ActorUserID.String(), input.ActorType)
			}
			if input.Action != auditActionExecuted || input.Outcome != "success" {
				t.Fatalf("audit = %s/%s", input.Action, input.Outcome)
			}
			return nil
		},
	}, provider{
		executeAction: func(ctx context.Context, input ExecuteProviderActionInput) (ProviderActionResult, error) {
			if input.UserID != userID || input.ExternalAccountRef != "ca_slack" || input.ToolkitSlug != "slack" {
				t.Fatalf("provider target = %#v", input)
			}
			if input.ActionSlug != "SLACK_SEND_MESSAGE" {
				t.Fatalf("action slug = %q, want Slack slug", input.ActionSlug)
			}
			if input.Arguments["channel"] != "C123" {
				t.Fatalf("arguments = %#v", input.Arguments)
			}
			return ProviderActionResult{
				Data:  map[string]any{"ok": true},
				LogID: "log_123",
			}, nil
		},
	}, catalogForTest(t))

	result, err := service.ExecuteAction(context.Background(), ExecuteActionInput{
		TenantID:         tenantID,
		OwnerScopeUserID: userID,
		ActorUserID:      userID,
		ActorType:        auditActorUser,
		ConnectionID:     connectionID,
		Action:           "send_message",
		Arguments:        map[string]any{"channel": "C123"},
	})
	if err != nil {
		t.Fatalf("execute action: %v", err)
	}
	if result.Action.ID != "send_message" || result.LogID != "log_123" {
		t.Fatalf("result = %#v", result)
	}
	if !auditCalled {
		t.Fatal("audit was not written")
	}
}

func TestExecuteActionDoesNotFailAfterProviderSuccessBookkeepingErrors(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	markCalled := false
	auditCalled := false
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:                 gotID,
				TenantID:           gotTenantID,
				UserID:             userID,
				Provider:           ProviderComposio,
				Service:            "slack",
				ExternalAccountRef: "ca_slack",
				Status:             StatusActive,
			}, nil
		},
		markConnectionUsed: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			markCalled = true
			return Connection{}, errors.New("mark used failed")
		},
		createAuditLog: func(ctx context.Context, input AuditLogInput) error {
			auditCalled = true
			return errors.New("audit failed")
		},
	}, provider{
		executeAction: func(ctx context.Context, input ExecuteProviderActionInput) (ProviderActionResult, error) {
			return ProviderActionResult{
				Data:  map[string]any{"ok": true},
				LogID: "log_123",
			}, nil
		},
	}, catalogForTest(t))

	result, err := service.ExecuteAction(context.Background(), ExecuteActionInput{
		TenantID:         tenantID,
		OwnerScopeUserID: userID,
		ActorUserID:      userID,
		ActorType:        auditActorUser,
		ConnectionID:     connectionID,
		Action:           "send_message",
		Arguments:        map[string]any{"channel": "C123"},
	})
	if err != nil {
		t.Fatalf("execute action: %v", err)
	}
	if result.Connection.ID != connectionID || result.LogID != "log_123" {
		t.Fatalf("result = %#v", result)
	}
	if !markCalled || !auditCalled {
		t.Fatalf("mark called = %t, audit called = %t", markCalled, auditCalled)
	}
}

func TestExecuteActionRejectsInactiveConnection(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:       gotID,
				TenantID: gotTenantID,
				UserID:   userID,
				Service:  "slack",
				Status:   StatusPending,
			}, nil
		},
	}, provider{}, catalogForTest(t))

	_, err := service.ExecuteAction(context.Background(), ExecuteActionInput{
		TenantID:         tenantID,
		OwnerScopeUserID: userID,
		ConnectionID:     connectionID,
		Action:           "send_message",
	})
	if !errors.Is(err, ErrConnectionNotActive) {
		t.Fatalf("error = %v, want inactive connection", err)
	}
}

func TestExecuteActionRejectsUnallowlistedAction(t *testing.T) {
	tenantID := mustID(t, "11111111-1111-4111-8111-111111111111")
	userID := mustID(t, "22222222-2222-4222-8222-222222222222")
	connectionID := mustID(t, "33333333-3333-4333-8333-333333333333")
	service := NewService(repository{
		getConnection: func(ctx context.Context, gotTenantID utilities.ID, gotID utilities.ID) (Connection, error) {
			return Connection{
				ID:       gotID,
				TenantID: gotTenantID,
				UserID:   userID,
				Service:  "slack",
				Status:   StatusActive,
			}, nil
		},
	}, provider{}, catalogForTest(t))

	_, err := service.ExecuteAction(context.Background(), ExecuteActionInput{
		TenantID:         tenantID,
		OwnerScopeUserID: userID,
		ConnectionID:     connectionID,
		Action:           "delete_channel",
	})
	if !errors.Is(err, ErrActionNotAllowed) {
		t.Fatalf("error = %v, want action not allowed", err)
	}
}

func catalogForTest(t *testing.T) Catalog {
	t.Helper()

	catalog, err := NewCatalog([]ServiceEntry{
		{ID: "slack", Family: "Work", DisplayName: "Slack", Provider: ProviderComposio, ToolkitSlug: "slack", AllowedActions: []ActionPolicy{{ID: "send_message", Slug: "SLACK_SEND_MESSAGE", DisplayName: "Send message"}}},
	})
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	return catalog
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
