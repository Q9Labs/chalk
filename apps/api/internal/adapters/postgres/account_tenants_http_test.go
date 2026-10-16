package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAccountTenantHTTPPreservesRedactedMediaConfig(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := context.Background()
	accountID := accountTenantIntegrationID(t)
	var tenantID utilities.ID
	if _, err := pool.Exec(ctx, `insert into users(id,name,email) values($1,'Config owner',$2)`, uuid(accountID), accountID.String()+"@account.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from tenant_onboarding_requests where account_id=$1`, uuid(accountID))
		pool.Exec(ctx, `delete from memberships where user_id=$1`, uuid(accountID))
		pool.Exec(ctx, `delete from tenants where id=$1`, uuid(tenantID))
		pool.Exec(ctx, `delete from users where id=$1`, uuid(accountID))
	})
	service := tenants.NewAccountService(NewAccountTenantRepository(sqlc.New(pool), pool, nil))
	router := httpapi.NewRouter(httpapi.Options{AccountTenants: service})
	request := func(method string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "/v1/me/tenants", strings.NewReader(`{"name":"Config projection"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", "config-projection-onboarding")
		r = r.WithContext(authentication.ContextWithPrincipal(ctx, authentication.Principal{Kind: authentication.PrincipalUser, UserID: accountID}))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, r)
		return response
	}
	type config struct {
		Provider string `json:"provider"`
		Token    string `json:"token"`
	}
	type tenant struct {
		ID     string  `json:"id"`
		Config *config `json:"media_plane_provider_config"`
	}
	var first struct {
		Tenant tenant `json:"tenant"`
	}
	response := request(http.MethodPost)
	if response.Code != http.StatusCreated {
		t.Fatalf("onboard: %d %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	parsedID, err := utilities.ParseID(first.Tenant.ID)
	if err != nil {
		t.Fatal(err)
	}
	tenantID = parsedID
	if first.Tenant.Config == nil || first.Tenant.Config.Provider != "cf_sfu" {
		t.Fatalf("onboard config missing: %s", response.Body.String())
	}
	if _, err := pool.Exec(ctx, `update tenants set media_plane_provider_config='{"provider":"cf_sfu","token":"must-not-leak"}'::jsonb where id=$1`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	response = request(http.MethodGet)
	var listed struct {
		Tenants []struct {
			Tenant tenant `json:"tenant"`
		} `json:"tenants"`
	}
	if response.Code != http.StatusOK {
		t.Fatalf("list: %d %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Tenants) != 1 || listed.Tenants[0].Tenant.Config == nil || listed.Tenants[0].Tenant.Config.Provider != "cf_sfu" || listed.Tenants[0].Tenant.Config.Token != utilities.RedactedValue {
		t.Fatalf("list config lost or unredacted: %s", response.Body.String())
	}
	response = request(http.MethodPost)
	var replay struct {
		Tenant   tenant `json:"tenant"`
		Replayed bool   `json:"replayed"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusCreated || !replay.Replayed || replay.Tenant.Config == nil || replay.Tenant.Config.Provider != "cf_sfu" || replay.Tenant.Config.Token != utilities.RedactedValue {
		t.Fatalf("replay config lost or unredacted: %d %s", response.Code, response.Body.String())
	}
}
