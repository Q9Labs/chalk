package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/scheduledepisodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// scheduledEpisodeHarness drives the real routes, service and repository against a migrated database.
type scheduledEpisodeHarness struct {
	t      *testing.T
	pool   *pgxpool.Pool
	router http.Handler
	key    *authentication.Principal
}

func newScheduledEpisodeHarness(t *testing.T) *scheduledEpisodeHarness {
	t.Helper()
	databaseURL := os.Getenv("CHALK_DATABASE_URL")
	if testing.Short() || databaseURL == "" {
		t.Skip("requires a migrated test database")
	}
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("test database unreachable: %v", err)
	}
	h := &scheduledEpisodeHarness{t: t, pool: pool}
	h.router = httpapi.NewRouter(httpapi.Options{
		TenantAuthz:       authorization.NewTenantPolicy(nil, nil),
		ScheduledEpisodes: scheduledepisodes.NewService(NewScheduledEpisodeRepository(pool)),
		Middleware: []func(http.Handler) http.Handler{func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if h.key != nil {
					r = r.WithContext(authentication.ContextWithPrincipal(r.Context(), *h.key))
				}
				next.ServeHTTP(w, r)
			})
		}},
	})
	return h
}

func (h *scheduledEpisodeHarness) seedTenantAndSpace() (tenant, space utilities.ID) {
	h.t.Helper()
	tenant, space = accountTenantIntegrationID(h.t), accountTenantIntegrationID(h.t)
	h.seedSpaceIn(tenant, space, true)
	return tenant, space
}

func (h *scheduledEpisodeHarness) seedSpaceIn(tenant, space utilities.ID, newTenant bool) {
	h.t.Helper()
	ctx := context.Background()
	if newTenant {
		if _, err := h.pool.Exec(ctx, `insert into tenants(id, name) values($1, 'Scheduled proof')`, uuid(tenant)); err != nil {
			h.t.Fatal(err)
		}
		h.t.Cleanup(func() {
			_, _ = h.pool.Exec(context.Background(), `delete from scheduled_episodes where tenant_id=$1`, uuid(tenant))
			_, _ = h.pool.Exec(context.Background(), `delete from spaces where tenant_id=$1`, uuid(tenant))
			_, _ = h.pool.Exec(context.Background(), `delete from tenants where id=$1`, uuid(tenant))
		})
	}
	if _, err := h.pool.Exec(ctx, `insert into spaces(id, tenant_id, name, slug, media_plane) values($1, $2, 'Scheduled proof', $3, $4)`,
		uuid(space), uuid(tenant), "sched-"+space.String(), mediaplane.ProviderChalkSFU); err != nil {
		h.t.Fatal(err)
	}
}

func (h *scheduledEpisodeHarness) keyFor(tenant utilities.ID, scopes ...authentication.Scope) {
	h.key = &authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: accountTenantIntegrationID(h.t), TenantID: tenant, Scopes: scopes}
}

func (h *scheduledEpisodeHarness) call(method string, tenant, space, booking utilities.ID, body string) (int, map[string]any) {
	h.t.Helper()
	path := "/v1/tenants/" + tenant.String() + "/spaces/" + space.String() + "/scheduled-episodes/" + booking.String()
	response := httptest.NewRecorder()
	h.router.ServeHTTP(response, httptest.NewRequest(method, path, strings.NewReader(body)))
	var decoded map[string]any
	if response.Body.Len() > 0 {
		decoder := json.NewDecoder(response.Body)
		decoder.UseNumber()
		if err := decoder.Decode(&decoded); err != nil {
			h.t.Fatalf("%s %s: body %q: %v", method, path, response.Body.String(), err)
		}
	}
	return response.Code, decoded
}

func errorCode(body map[string]any) string {
	if inner, ok := body["error"].(map[string]any); ok {
		code, _ := inner["code"].(string)
		return code
	}
	code, _ := body["code"].(string)
	return code
}

func (h *scheduledEpisodeHarness) expect(method string, tenant, space, booking utilities.ID, body string, want int, code string) map[string]any {
	h.t.Helper()
	status, decoded := h.call(method, tenant, space, booking, body)
	if status != want {
		h.t.Fatalf("%s = %d, want %d: %v", method, status, want, decoded)
	}
	if code != "" && errorCode(decoded) != code {
		h.t.Fatalf("%s error code = %q, want %q: %v", method, errorCode(decoded), code, decoded)
	}
	return decoded
}
