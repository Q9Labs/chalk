package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestTenantRecordingRenderHTTPPersistence(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repo := NewTenantRepository(sqlc.New(pool))
	service := tenants.NewService(repo)
	serviceID := "render-settings-" + accountTenantIntegrationID(t).String()
	tenant, err := service.CreateTenant(t.Context(), tenants.CreateTenantInput{Name: "Render settings fixture", CreatedByServiceID: &serviceID})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `delete from tenants where id=$1`, tenant.ID.String()); err != nil {
			t.Error(err)
		}
	})
	if tenant.RecordingRenderMode != tenants.RecordingRenderOnDemand {
		t.Fatalf("new tenant mode=%q", tenant.RecordingRenderMode)
	}
	token := strings.Repeat("s", 32)
	server := func(id string, scopes []authentication.Scope) *httptest.Server {
		result := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
			ServicePrincipal: authentication.ServiceCredential{ID: id, Secrets: []string{token}, Scopes: scopes},
			Tenants:          service, TenantAuthz: authorization.NewTenantPolicy(nil, repo),
		}))
		t.Cleanup(result.Close)
		return result
	}
	owner := server(serviceID, []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite})
	target := owner.URL + "/v1/tenants/" + tenant.ID.String()
	read := func(want tenants.RecordingRenderMode) {
		t.Helper()
		result := serviceHTTPRequest(owner.Client(), http.MethodGet, target, token, "")
		var body struct {
			RecordingRenderMode tenants.RecordingRenderMode `json:"recording_render_mode"`
		}
		if result.err != nil || result.status != http.StatusOK || json.Unmarshal(result.body, &body) != nil || body.RecordingRenderMode != want {
			t.Fatalf("GET: status=%d body=%s err=%v want=%s", result.status, result.body, result.err, want)
		}
	}
	read(tenants.RecordingRenderOnDemand)
	for _, mode := range []tenants.RecordingRenderMode{tenants.RecordingRenderAutomatic, tenants.RecordingRenderOnDemand} {
		result := serviceHTTPRequest(owner.Client(), http.MethodPatch, target, token, `{"recording_render_mode":"`+string(mode)+`"}`)
		if result.err != nil || result.status != http.StatusOK {
			t.Fatalf("PATCH: status=%d body=%s err=%v", result.status, result.body, result.err)
		}
		read(mode)
		persisted, err := repo.GetTenant(t.Context(), tenant.ID)
		if err != nil || persisted.RecordingRenderMode != mode {
			t.Fatalf("persisted mode=%q err=%v", persisted.RecordingRenderMode, err)
		}
	}
	for _, body := range []string{`{"recording_render_mode":null}`, `{"recording_render_mode":"always"}`, `{"recording_render_mode":true}`} {
		result := serviceHTTPRequest(owner.Client(), http.MethodPatch, target, token, body)
		if result.status != http.StatusBadRequest {
			t.Fatalf("invalid mode status=%d body=%s", result.status, result.body)
		}
	}
	for _, tc := range []struct {
		id     string
		scopes []authentication.Scope
	}{
		{"foreign-" + serviceID, []authentication.Scope{authentication.ScopeTenantsWrite}},
		{serviceID, []authentication.Scope{authentication.ScopeTenantsRead}},
	} {
		caller := server(tc.id, tc.scopes)
		result := serviceHTTPRequest(caller.Client(), http.MethodPatch, caller.URL+"/v1/tenants/"+tenant.ID.String(), token, `{"recording_render_mode":"automatic"}`)
		if result.status != http.StatusForbidden {
			t.Fatalf("unauthorized PATCH status=%d body=%s", result.status, result.body)
		}
	}
	result := serviceHTTPRequest(owner.Client(), http.MethodPatch, target, token, `{"recording_render_mode":"automatic","name":"Forbidden service rename"}`)
	if result.status != http.StatusForbidden {
		t.Fatalf("mixed forbidden update status=%d body=%s", result.status, result.body)
	}
	read(tenants.RecordingRenderOnDemand)
}

func TestTenantRecordingRenderMigrationDefaultsExistingTenants(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	schema := "render_mode_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")
	if _, err := tx.Exec(t.Context(), `create schema `+schema+`; set local search_path to `+schema+`; create table tenants (id int primary key); insert into tenants(id) values (1)`); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../../db/migrations/20261023153001_tenant_recording_render_mode.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, down, ok := strings.Cut(string(migration), "-- +goose Down")
	if !ok {
		t.Fatal("missing down migration")
	}
	for pass := 0; pass < 2; pass++ {
		if _, err := tx.Exec(t.Context(), up); err != nil {
			t.Fatal(err)
		}
		var mode string
		if err := tx.QueryRow(t.Context(), `select recording_render_mode from tenants where id=1`).Scan(&mode); err != nil || mode != "on_demand" {
			t.Fatalf("existing tenant mode=%q err=%v", mode, err)
		}
		if _, err := tx.Exec(t.Context(), down); err != nil {
			t.Fatal(err)
		}
	}
}
