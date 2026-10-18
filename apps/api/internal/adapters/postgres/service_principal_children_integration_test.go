package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func TestServicePrincipalChildResourceIsolation(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	queries := sqlc.New(pool)
	tenantRepository := NewTenantRepository(queries)
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	webhookRepository := NewWebhookRepository(pool, protector)
	serviceID := "child-isolation-" + accountTenantIntegrationID(t).String()
	secret := strings.Repeat("s", 32)
	server := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
		LocalSystemToken:    "child-isolation-system",
		ServicePrincipal:    authentication.ServiceCredential{ID: serviceID, Secrets: []string{secret}, Scopes: authentication.AllScopes},
		TenantAuthz:         authorization.NewTenantPolicy(nil, tenantRepository),
		Spaces:              spaces.NewService(NewSpaceRepository(queries, pool)),
		Episodes:            episodes.NewService(NewEpisodeLifecycleRepository(pool)),
		Recordings:          recordings.NewService(NewRecordingRepository(queries)),
		RecordingExports:    recordingpipeline.NewService(NewRecordingPipelineRepositoryWithPool(pool)),
		TranscriptArtifacts: transcripts.NewService(NewTranscriptRepository(queries)),
		Webhooks:            webhooks.NewService(webhookRepository, protector),
	}))
	t.Cleanup(server.Close)
	type fixture struct{ tenant, space, episode, recording, transcript, endpoint, delivery utilities.ID }
	fixtures := make([]fixture, 2)
	for i := range fixtures {
		f := &fixtures[i]
		f.tenant, f.space, f.episode = accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
		f.recording, f.transcript, f.delivery = accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
		owner := serviceID
		if i == 1 {
			owner += "-foreign"
		}
		if _, err := pool.Exec(ctx, `insert into tenants(id,name,created_by_service_id) values($1,'Child isolation',$2)`, uuid(f.tenant), owner); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			for _, table := range []string{"webhook_events", "webhook_endpoints", "transcriptions", "recordings", "episodes", "spaces"} {
				if _, err := pool.Exec(cleanupCtx, "delete from "+table+" where tenant_id=$1", uuid(f.tenant)); err != nil {
					t.Errorf("cleanup %s: %v", table, err)
				}
			}
			if _, err := pool.Exec(cleanupCtx, `delete from tenants where id=$1`, uuid(f.tenant)); err != nil {
				t.Error(err)
			}
		})
		for _, statement := range []struct {
			query string
			args  []any
		}{
			{`insert into tenant_artifact_policies(tenant_id) values($1)`, []any{uuid(f.tenant)}},
			{`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Isolation',$3,'cf_sfu')`, []any{uuid(f.space), uuid(f.tenant), f.space.String()}},
			{`insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'ended','{}')`, []any{uuid(f.episode), uuid(f.tenant), uuid(f.space)}},
			{`insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values($1,$2,$3,$4,'completed','r2')`, []any{uuid(f.recording), uuid(f.tenant), uuid(f.space), uuid(f.episode)}},
			{`insert into transcriptions(id,tenant_id,recording_id,space_id,episode_id,status,languages) values($1,$2,$3,$4,$5,'not_requested','{}')`, []any{uuid(f.transcript), uuid(f.tenant), uuid(f.recording), uuid(f.space), uuid(f.episode)}},
		} {
			if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
				t.Fatal(err)
			}
		}
		endpoint, err := webhookRepository.Create(ctx, webhooks.CreateInput{TenantID: f.tenant, Name: "Isolation", URL: "https://example.com/hook", Enabled: true, APIVersion: 1, EventTypes: []string{"participant.joined"}, IdempotencyKey: "child-isolation-create"})
		if err != nil {
			t.Fatal(err)
		}
		f.endpoint = endpoint.Endpoint.ID
		event, journey, queued := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
		if _, err := pool.Exec(ctx, `insert into webhook_events(id,tenant_id,event_name,api_version,occurred_at,body,body_sha256,semantic_transition_key,resource_type,resource_id,journey_id) values($1,$2,'participant.joined',1,now(),'{}',decode(repeat('00',32),'hex'),$3,'participant',$4,$5)`, uuid(event), uuid(f.tenant), event.String(), uuid(f.endpoint), uuid(journey)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `insert into webhook_deliveries(id,tenant_id,event_id,endpoint_id,endpoint_revision_id,endpoint_revision,state,next_attempt_at,queued_journey_event_id) select $1,$2,$3,$4,id,1,'pending',now(),$5 from webhook_endpoint_revisions where tenant_id=$2 and endpoint_id=$4 and revision=1`, uuid(f.delivery), uuid(f.tenant), uuid(event), uuid(f.endpoint), uuid(queued)); err != nil {
			t.Fatal(err)
		}
	}
	owned, foreign := fixtures[0], fixtures[1]
	paths := func(f fixture) []string {
		return []string{
			"/spaces/" + f.space.String(),
			"/spaces/" + f.space.String() + "/episodes/" + f.episode.String(),
			"/recordings/" + f.recording.String(),
			"/transcripts/" + f.transcript.String(),
			"/webhook-endpoints/" + f.endpoint.String(),
			"/webhook-endpoints/" + f.endpoint.String() + "/deliveries/" + f.delivery.String(),
		}
	}
	check := func(tenant utilities.ID, path, bearer string, want int) []byte {
		t.Helper()
		result := serviceHTTPRequest(server.Client(), "GET", server.URL+"/v1/tenants/"+tenant.String()+path, bearer, "")
		if result.err != nil || result.status != want {
			t.Fatalf("GET %s/%s: status=%d err=%v body=%s want=%d", tenant, path, result.status, result.err, result.body, want)
		}
		return result.body
	}
	for i, path := range paths(foreign) {
		// Positive controls prove each foreign child exists and the route reaches the database.
		check(foreign.tenant, path, "child-isolation-system", http.StatusOK)
		check(owned.tenant, paths(owned)[i], secret, http.StatusOK)
		check(foreign.tenant, path, secret, http.StatusForbidden)
		check(owned.tenant, path, secret, http.StatusNotFound)
	}
	// Exercise nested parent substitution as well as a foreign Tenant URL.
	check(owned.tenant, "/spaces/"+owned.space.String()+"/episodes/"+foreign.episode.String(), secret, http.StatusNotFound)
	check(owned.tenant, "/webhook-endpoints/"+owned.endpoint.String()+"/deliveries/"+foreign.delivery.String(), secret, http.StatusNotFound)
	for _, path := range []string{"/spaces", "/spaces/" + foreign.space.String() + "/episodes", "/recordings", "/transcripts", "/webhook-endpoints", "/webhook-endpoints/" + foreign.endpoint.String() + "/deliveries"} {
		check(foreign.tenant, path, secret, http.StatusForbidden)
	}
	for _, list := range []struct{ path, empty string }{
		{"/spaces/" + foreign.space.String() + "/episodes", `"episodes":[]`},
		{"/webhook-endpoints/" + foreign.endpoint.String() + "/deliveries", `"deliveries":[]`},
		{"/recordings?space_id=" + foreign.space.String(), `"recordings":[]`},
		{"/recordings?episode_id=" + foreign.episode.String(), `"recordings":[]`},
		{"/transcripts?recording_id=" + foreign.recording.String(), `"transcripts":[]`},
	} {
		body := check(owned.tenant, list.path, secret, http.StatusOK)
		if !bytes.Contains(body, []byte(list.empty)) {
			t.Fatalf("foreign parent list not empty: %s", body)
		}
	}
}

func TestServiceTenantLookupRotatedSecretsShareReadBudget(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewTenantRepository(sqlc.New(pool))
	serviceID := "lookup-budget-" + accountTenantIntegrationID(t).String()
	oldSecret, newSecret := strings.Repeat("o", 32), strings.Repeat("n", 32)
	limits := httpapi.DefaultRateLimitOptions()
	limits.Now = func() time.Time { return time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC) }
	server := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
		ServicePrincipal: authentication.ServiceCredential{ID: serviceID, Secrets: []string{oldSecret, newSecret}, Scopes: []authentication.Scope{authentication.ScopeTenantsRead}},
		Tenants:          tenants.NewService(repository), TenantAuthz: authorization.NewTenantPolicy(nil, repository), RateLimit: limits,
	}))
	t.Cleanup(server.Close)
	for i := 0; i < 301; i++ {
		secret := oldSecret
		if i%2 == 1 {
			secret = newSecret
		}
		result := serviceHTTPRequest(server.Client(), "GET", server.URL+"/v1/tenants/by-external-id?external_id=missing", secret, "")
		want := http.StatusNotFound
		if i == 300 {
			want = http.StatusTooManyRequests
		}
		if result.err != nil || result.status != want {
			t.Fatalf("lookup %d: status=%d error=%v body=%s want=%d", i+1, result.status, result.err, result.body, want)
		}
	}
}

func TestTenantReadRoutesLimitServiceAndExemptSystem(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewTenantRepository(sqlc.New(pool))
	serviceID := "read-budget-" + accountTenantIntegrationID(t).String()
	oldSecret, newSecret := strings.Repeat("o", 32), strings.Repeat("n", 32)
	const systemToken = "local-test-system"
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(cleanupCtx, `delete from tenants where created_by_service_id = $1`, serviceID); err != nil {
			t.Errorf("cleanup service fixtures: %v", err)
		}
	})
	// Every route gets its own server, so each starts with a full budget at the same fixed time.
	serve := func() *httptest.Server {
		limits := httpapi.DefaultRateLimitOptions()
		limits.Now = func() time.Time { return time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC) }
		server := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
			LocalSystemToken: systemToken,
			ServicePrincipal: authentication.ServiceCredential{ID: serviceID, Secrets: []string{oldSecret, newSecret}, Scopes: []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite}},
			Tenants:          tenants.NewService(repository), TenantAuthz: authorization.NewTenantPolicy(nil, repository), RateLimit: limits,
		}))
		t.Cleanup(server.Close)
		return server
	}
	created := serviceHTTPRequest(http.DefaultClient, "POST", serve().URL+"/v1/tenants", oldSecret, `{"name":"Read budget","external_id":"read-budget-person"}`)
	var tenant struct {
		ID string `json:"id"`
	}
	if created.err != nil || created.status != http.StatusCreated || json.Unmarshal(created.body, &tenant) != nil || tenant.ID == "" {
		t.Fatalf("create owned Tenant: status=%d error=%v body=%s", created.status, created.err, created.body)
	}
	for _, path := range []string{"/v1/tenants", "/v1/tenants/" + tenant.ID} {
		server := serve()
		for i := 0; i < 301; i++ {
			secret := oldSecret
			if i%2 == 1 {
				secret = newSecret
			}
			result := serviceHTTPRequest(server.Client(), "GET", server.URL+path, secret, "")
			want := http.StatusOK
			if i == 300 {
				want = http.StatusTooManyRequests
			}
			if result.err != nil || result.status != want {
				t.Fatalf("service GET %s request %d: status=%d error=%v body=%s want=%d", path, i+1, result.status, result.err, result.body, want)
			}
		}
		system := serve()
		for i := 0; i < 305; i++ {
			result := serviceHTTPRequest(system.Client(), "GET", system.URL+path, systemToken, "")
			if result.err != nil || result.status != http.StatusOK {
				t.Fatalf("System GET %s request %d: status=%d error=%v body=%s", path, i+1, result.status, result.err, result.body)
			}
		}
	}
}
