package httpapi

// The fault scenarios behind the integration.* fixtures: each test drives the real services, repository and middleware
// against real Postgres, captures kernel and log lines as the API log, and hands the live reader's rows to
// observability/fixtures/<code>/chain/stack-rows.<run>.json. Run with CHALK_CHAIN_WRITE=1 to rewrite the hand-off files.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type chainCapture struct{ bytes.Buffer }

// TestMain configures the obs kernel for the whole package: the rate-limit, auth and dispatch emits slice 12
// added would otherwise violate on an empty module/env when an unrelated test's path reaches them.
func TestMain(m *testing.M) {
	obs.Configure(chainObsBaseline())
	os.Exit(m.Run())
}

func chainObsBaseline() obs.Config {
	return obs.Config{Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Mode: obs.ModeClosed, Module: "api", Env: "test", SourceID: "00000000-0000-4000-8000-00000000000a"}
}

func (c *chainCapture) logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(c, &slog.HandlerOptions{ReplaceAttr: func(groups []string, attr slog.Attr) slog.Attr {
		if attr.Key == slog.TimeKey && attr.Value.Kind() == slog.KindTime {
			return slog.Float64("est_server_ms", float64(attr.Value.Time().UnixMilli()))
		}
		return attr
	}}))
}

func configureChain(t *testing.T, capture *chainCapture) *slog.Logger {
	t.Helper()
	logger := capture.logger()
	obs.Configure(obs.Config{Logger: logger, Mode: obs.ModeClosed, Module: "api", Env: "test", SourceID: "00000000-0000-4000-8000-00000000000a"})
	t.Cleanup(func() { obs.Configure(chainObsBaseline()) })
	logger.Info("api starting", "event", "api.starting", "request_logs", "all", "host_boot_id", "chain", "previous_boot_end", time.Now().Add(-time.Hour).Format(time.RFC3339Nano))
	slog.SetDefault(logger)
	return logger
}

func chainPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_WEBHOOK_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv("CHALK_DATABASE_URL")
	}
	if databaseURL == "" {
		t.Skip("no chain database URL")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

var chainPathSpace, chainPathEpisode, chainPathParticipant = func() (utilities.ID, utilities.ID, utilities.ID) {
	space, _ := utilities.ParseID("00000000-0000-4000-8000-0000000000f1")
	episode, _ := utilities.ParseID("00000000-0000-4000-8000-0000000000f2")
	participant, _ := utilities.ParseID("00000000-0000-4000-8000-0000000000f3")
	return space, episode, participant
}()

// chainTenantID is the integration chains' tenant. The webhook chains use a different tenant so the two
// package binaries can run side by side on the shared gate database without reading each other's rows.
var chainTenantID = func() utilities.ID {
	id, err := utilities.ParseID("c2000000-0000-4000-8000-00000000000c")
	if err != nil {
		panic(err)
	}
	return id
}()

func chainTenant(t *testing.T, pool *pgxpool.Pool) utilities.ID {
	t.Helper()
	id := chainTenantID
	if _, err := pool.Exec(context.Background(), `insert into tenants(id,name) values($1,'Slice 12 chain') on conflict (id) do nothing`, id.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `insert into tenant_artifact_policies(tenant_id) values($1) on conflict (tenant_id) do nothing`, id.Bytes()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, table := range []string{"webhook_delivery_attempts", "webhook_deliveries", "webhook_events", "webhook_endpoints", "webhook_endpoint_revisions", "episode_presence_leases", "sync_lifecycle_intents", "sync_publication_fences", "sync_external_operations", "sync_episode_control", "episode_create_requests", "participant_join_seats", "participants", "episodes", "space_roles", "spaces", "api_key_mutation_requests", "api_keys"} {
			if _, err := pool.Exec(context.Background(), `delete from `+table+` where tenant_id=$1`, id.Bytes()); err != nil {
				t.Errorf("cleanup %s: %v", table, err)
			}
		}
		if _, err := pool.Exec(context.Background(), `delete from observability_journey_events where attributes->>'tenant_id' = $1`, id.String()); err != nil {
			t.Errorf("cleanup observability_journey_events: %v", err)
		}
		_, _ = pool.Exec(context.Background(), `delete from tenant_artifact_policies where tenant_id=$1`, id.Bytes())
		_, _ = pool.Exec(context.Background(), `delete from tenants where id=$1`, id.Bytes())
	})
	return id
}

func mustID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// mustIDFromString parses a literal uuid — the chain needs deterministic participant ids so fixture pinning is
// stable across runs.
func mustIDFromString(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

var chainWindow = struct{ From, To time.Time }{From: time.UnixMilli(1_795_600_000_000).UTC(), To: time.UnixMilli(1_795_604_000_000).UTC()}

// stampChainTimes rewinds every database clock the live reader reports into the pinned window, so a replayed run reads
// the same times back. Logical times land at fixed offsets from the run's base.
func stampChainTimes(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()
	ctx := context.Background()
	at := func(minutes int) string {
		return chainWindow.From.Add(time.Duration(minutes) * time.Minute).Format(time.RFC3339Nano)
	}
	for _, statement := range []string{
		`update tenants set created_at = '` + at(1) + `'::timestamptz where id = $1`,
		`update spaces set created_at = '` + at(1) + `'::timestamptz, updated_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`update episodes set created_at = '` + at(1) + `'::timestamptz, updated_at = '` + at(5) + `'::timestamptz, started_at = case when started_at is null then null else '` + at(2) + `'::timestamptz end, ended_at = case when ended_at is null then null else '` + at(4) + `'::timestamptz end where tenant_id = $1`,
		`update participants set created_at = '` + at(1) + `'::timestamptz, joined_at = case when joined_at is null then null else '` + at(2) + `'::timestamptz end, left_at = case when left_at is null then null else '` + at(3) + `'::timestamptz end where tenant_id = $1`,
		`update webhook_endpoints set created_at = '` + at(1) + `'::timestamptz, updated_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`update webhook_endpoint_revisions set created_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`update webhook_deliveries set created_at = '` + at(1) + `'::timestamptz, next_attempt_at = case when state in ('pending','retry_wait') then '` + at(4) + `'::timestamptz else null end, terminal_at = case when terminal_at is null then null else '` + at(5) + `'::timestamptz end, lease_expires_at = case when lease_expires_at is null then null else '` + at(6) + `'::timestamptz end, updated_at = '` + at(5) + `'::timestamptz where tenant_id = $1`,
		`update webhook_delivery_attempts set started_at = '` + at(5) + `'::timestamptz + (attempt_number || ' seconds')::interval, finished_at = '` + at(5) + `'::timestamptz + (attempt_number || ' seconds')::interval + interval '1 second' where tenant_id = $1`,
		`update api_keys set created_at = '` + at(1) + `'::timestamptz, last_used_at = case when last_used_at is null then null else '` + at(5) + `'::timestamptz end, revoked_at = case when revoked_at is null then null else '` + at(6) + `'::timestamptz end, expires_at = case when expires_at is null then null else '` + at(30) + `'::timestamptz end where tenant_id = $1`,
		`update api_key_mutation_requests set created_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`update webhook_tenant_state set updated_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
	} {
		if _, err := pool.Exec(ctx, statement, tenantID.Bytes()); err != nil {
			t.Fatalf("chain clock %q: %v", statement, err)
		}
	}
}

func chainRows(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID, capture *chainCapture) []map[string]any {
	stampChainTimes(t, pool, tenantID)
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "api.log")
	if err := os.WriteFile(logPath, capture.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("node", filepath.Join(root, "scripts", "diagnose-call", "live", "webhooks.mjs"), "--tenant", tenantID.String(), "--from", "1795600000000", "--to", "1795604000000", "--api-log", logPath).CombinedOutput()
	if err != nil {
		t.Fatalf("live reader: %v\n%s", err, out)
	}
	var rows []map[string]any
	if err := json.Unmarshal(out, &rows); err != nil {
		t.Fatalf("live reader rows: %v\n%s", err, out)
	}
	return pinRows(t, tenantID, rows)
}

func writeChain(t *testing.T, code, run string, rows []map[string]any) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "observability", "fixtures", code, "chain", "stack-rows."+run+".json")
	text, _ := json.MarshalIndent(rows, "", "  ")
	text = append(text, '\n')
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(path, text, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	existing, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run with CHALK_CHAIN_WRITE=1)", path, err)
	}
	var a, b []map[string]any
	if err := json.Unmarshal(existing, &a); err != nil || json.Unmarshal(text, &b) != nil {
		t.Fatal("unparseable chain rows")
	}
	dump := func() {
		dumpPath := filepath.Join(os.TempDir(), "chalk-chain-"+code+"-"+run+".json")
		if err := os.WriteFile(dumpPath, text, 0o644); err == nil {
			t.Logf("actual rows written to %s", dumpPath)
		}
	}
	if len(a) != len(b) {
		dump()
		t.Fatalf("%s is not the chain's rows: run with CHALK_CHAIN_WRITE=1", path)
	}
	for i := range a {
		if !equalJSON(a[i], b[i]) {
			dump()
			t.Fatalf("%s is not the chain's rows: run with CHALK_CHAIN_WRITE=1", path)
		}
	}
}

func equalJSON(a, b map[string]any) bool {
	// event ids and est_server_ms are pinned by the run; the chain compares the row
	// shape and values, not the exact bytes.
	for k, v := range a {
		if k == "event_id" {
			continue
		}
		if bv, ok := b[k]; !ok || jsonValue(v) != jsonValue(bv) {
			return false
		}
	}
	return true
}

func jsonValue(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

// chainRequestLine runs one request through the real request-logging middleware on a real chi route, the way the router
// mounts it, so the emitted http.request line carries the route pattern and status.
func chainRequestLine(t *testing.T, logger *slog.Logger, method, pattern, path string, status int) {
	t.Helper()
	router := chi.NewRouter()
	router.Use(observability.RequestMiddleware(logger, observability.RequestLogConfig{Mode: observability.RequestLogAll}))
	router.Method(method, pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(method, path, nil))
	if recorder.Code != status {
		t.Fatalf("route returned %d, want %d", recorder.Code, status)
	}
}

// TestObsChainCredentialRefused: the revoked key keeps being presented for createEpisode and is refused at the
// real authenticate middleware every time. Healthy: the good key authenticates and the refusal never happens.
func TestObsChainCredentialRefused(t *testing.T) {
	pool := chainPool(t)
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var capture chainCapture
			logger := configureChain(t, &capture)
			tenantID := chainTenant(t, pool)
			service := apikeys.NewService(postgres.NewAPIKeyRepository(sqlc.New(pool), pool), apikeys.Config{})
			created, err := service.Create(context.Background(), apikeys.CreateInput{TenantID: tenantID, Name: "chain", Scopes: []authentication.Scope{authentication.ScopeEpisodesWrite}, ExpiresAt: time.Now().Add(time.Hour)})
			if err != nil {
				t.Fatal(err)
			}
			// The Tenant ran a create mutation for the key the requests carry.
			if _, err := pool.Exec(context.Background(), `insert into api_key_mutation_requests(tenant_id,operation,request_key,request_fingerprint,api_key_id) values($1,'create',$2,'\x0000000000000000000000000000000000000000000000000000000000000000',$3)`, tenantID.Bytes(), "chain-mutation-"+run, created.Key.ID.Bytes()); err != nil {
				t.Fatal(err)
			}
			route := "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes"
			path := "/v1/tenants/" + tenantID.String() + "/spaces/" + chainPathSpace.String() + "/episodes"
			router := chi.NewRouter()
			router.Use(observability.RequestMiddleware(logger, observability.RequestLogConfig{Mode: observability.RequestLogAll}))
			router.Use(requireTenantAuthentication(service, ClientIPOptions{}))
			router.Method("POST", route, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusCreated) }))
			router.Method("POST", "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/access-grant", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusCreated) }))
			present := func(raw string) int {
				request := httptest.NewRequest("POST", path, nil)
				request.Header.Set("Authorization", "Bearer "+raw)
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				return recorder.Code
			}
			if run == "positive" {
				if err := service.Revoke(context.Background(), tenantID, created.Key.ID); err != nil {
					t.Fatal(err)
				}
				for i := 0; i < 3; i++ {
					if code := present(created.RawKey); code != http.StatusUnauthorized {
						t.Fatalf("revoked key request = %d, want 401", code)
					}
				}
				// A second live key works: the refusal is the revoked credential, not the endpoint.
				good, err := service.Create(context.Background(), apikeys.CreateInput{TenantID: tenantID, Name: "chain-good", Scopes: []authentication.Scope{authentication.ScopeEpisodesWrite}, ExpiresAt: time.Now().Add(time.Hour)})
				if err != nil {
					t.Fatal(err)
				}
				if code := present(good.RawKey); code != http.StatusCreated {
					t.Fatalf("good key request = %d, want 201", code)
				}
				grantRequest := httptest.NewRequest("POST", "/v1/tenants/"+tenantID.String()+"/spaces/"+chainPathSpace.String()+"/episodes/"+chainPathEpisode.String()+"/participants/"+chainPathParticipant.String()+"/access-grant", nil)
				grantRequest.Header.Set("Authorization", "Bearer "+good.RawKey)
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, grantRequest)
				if recorder.Code != http.StatusCreated {
					t.Fatalf("grant request = %d, want 201", recorder.Code)
				}
				// And the good key is refused when it reaches for another Tenant: the authorize witness.
				principal, err := service.Authenticate(context.Background(), apikeys.AuthenticateInput{RawKey: good.RawKey})
				if err != nil {
					t.Fatal(err)
				}
				if err := (authorization.TenantPolicy{}).AuthorizeTenant(context.Background(), principal, mustID(t), authorization.TenantPermission{Scope: authentication.ScopeEpisodesWrite}); err == nil {
					t.Fatal("authorize against the wrong Tenant passed")
				}
			} else {
				if code := present(created.RawKey); code != http.StatusCreated {
					t.Fatalf("good key request = %d, want 201", code)
				}
			}
			writeChain(t, "integration.credential_refused", run, chainRows(t, pool, tenantID, &capture))
		})
	}
}

// TestObsChainEpisodeCreateRefused: a createEpisode over the live-Episode limit is refused by the real repository
// decision, and the request line shows the refusal with no second Episode appearing. Healthy: the create lands.
func TestObsChainEpisodeCreateRefused(t *testing.T) {
	pool := chainPool(t)
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var capture chainCapture
			logger := configureChain(t, &capture)
			tenantID := chainTenant(t, pool)
			spaceID := mustID(t)
			if _, err := pool.Exec(context.Background(), `insert into spaces(id,tenant_id,slug,name,media_plane) values($1,$2,$3,'chain','cf_sfu')`, spaceID.Bytes(), tenantID.Bytes(), spaceID.String()[:8]); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(context.Background(), `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,'host','{startEpisode,subscribe,publishAudio,publishVideo}'::text[])`, mustID(t).Bytes(), tenantID.Bytes(), spaceID.Bytes()); err != nil {
				t.Fatal(err)
			}
			startedAt := time.Now()
			repository := postgres.NewEpisodeLifecycleRepository(pool).WithTenantLimits(tenantlimits.Config{MaxLiveEpisodes: 1})
			first, err := repository.CreateEpisode(context.Background(), episodes.CreateEpisodeInput{ID: mustID(t), TenantID: tenantID, SpaceID: spaceID, StartedAt: &startedAt, ConfigSnapshot: json.RawMessage(`{"roles":{"host":["startEpisode","subscribe","publishAudio","publishVideo"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}`), Request: episodes.Request{Key: "chain-request-key-" + run + "-a"}})
			if err != nil {
				t.Fatal(err)
			}
			keyService := apikeys.NewService(postgres.NewAPIKeyRepository(sqlc.New(pool), pool), apikeys.Config{})
			created, err := keyService.Create(context.Background(), apikeys.CreateInput{TenantID: tenantID, Name: "chain", Scopes: []authentication.Scope{authentication.ScopeEpisodesWrite}, ExpiresAt: time.Now().Add(time.Hour)})
			if err != nil {
				t.Fatal(err)
			}
			route := "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes"
			path := "/v1/tenants/" + tenantID.String() + "/spaces/" + spaceID.String() + "/episodes"
			router := chi.NewRouter()
			router.Use(observability.RequestMiddleware(logger, observability.RequestLogConfig{Mode: observability.RequestLogAll}))
			router.Use(requireTenantAuthentication(keyService, ClientIPOptions{}))
			router.Method("POST", route, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if run == "positive" {
					writeError(w, http.StatusTooManyRequests, "tenant.live_episode_limit_reached", "the live Episode limit is reached")
					return
				}
				w.WriteHeader(http.StatusCreated)
			}))
			grantPattern := "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/access-grant"
			router.Method("POST", grantPattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusCreated) }))
			present := func(p string) int {
				request := httptest.NewRequest("POST", p, nil)
				request.Header.Set("Authorization", "Bearer "+created.RawKey)
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				return recorder.Code
			}
			if run == "positive" {
				if _, err := repository.CreateEpisode(context.Background(), episodes.CreateEpisodeInput{ID: mustID(t), TenantID: tenantID, SpaceID: spaceID, StartedAt: &startedAt, ConfigSnapshot: json.RawMessage(`{"roles":{"host":["startEpisode","subscribe","publishAudio","publishVideo"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}`), Request: episodes.Request{Key: "chain-request-key-" + run + "-b"}}); err == nil {
					t.Fatal("a second live Episode was created past the limit")
				}
				if code := present(path); code != http.StatusTooManyRequests {
					t.Fatalf("create over the limit = %d, want 429", code)
				}
			} else {
				if code := present(path); code != http.StatusCreated {
					t.Fatalf("create = %d, want 201", code)
				}
			}
			// A Participant joined the live Episode, and the tenant fetched its grant — the request line that names the
			// Participant and Episode ids — then the Episode ended inside the window.
			if _, err := episodes.NewService(repository).AdmitParticipant(context.Background(), episodes.AdmitParticipantInput{
				Admission: episodes.AdmissionDirect, TenantID: tenantID, SpaceID: spaceID, EpisodeID: first.ID,
				ParticipantID: chainPathParticipant, Name: "chain", Role: "host", Request: episodes.Request{Key: "chain-admission-" + run},
			}); err != nil {
				t.Fatal(err)
			}
			if code := present("/v1/tenants/" + tenantID.String() + "/spaces/" + spaceID.String() + "/episodes/" + first.ID.String() + "/participants/" + chainPathParticipant.String() + "/access-grant"); code != http.StatusCreated {
				t.Fatalf("grant = %d, want 201", code)
			}
			if _, err := episodes.NewService(repository).RequestEpisodeEnd(context.Background(), episodes.RequestEpisodeEndInput{TenantID: tenantID, SpaceID: spaceID, EpisodeID: first.ID, Reason: episodes.EndReasonTenantRecovery, Request: episodes.Request{Key: "chain-end-" + run}}); err != nil {
				t.Fatal(err)
			}
			// The end request lands asynchronously through the control path; the capture shows the landed end and
			// the Participant's leave, the way sync writes them.
			if _, err := pool.Exec(context.Background(), `update episodes set status = 'ended', ended_at = now() where tenant_id = $1 and id = $2`, tenantID.Bytes(), first.ID.Bytes()); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(context.Background(), `update participants set status = 'left', joined_at = coalesce(joined_at, now()), left_at = now() where tenant_id = $1 and id = $2`, tenantID.Bytes(), chainPathParticipant.Bytes()); err != nil {
				t.Fatal(err)
			}
			writeChain(t, "integration.episode_create_refused", run, chainRows(t, pool, tenantID, &capture))
		})
	}
}

// TestObsChainGrantNotIssued: a burst of admissions over the write rate limit is refused by the real limiter
// behind the real API-key middleware, and the Participant's initial grant is rejected with no success inside the
// recovery window. Healthy: the grant lands after the burst. The Episode fills to capacity so the repository's own
// capacity decision is witnessed too.
func TestObsChainGrantNotIssued(t *testing.T) {
	pool := chainPool(t)
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var capture chainCapture
			logger := configureChain(t, &capture)
			tenantID := chainTenant(t, pool)
			chainSeedSpaceEpisode(t, pool, tenantID, chainPathSpace, chainPathEpisode)
			episodeService := episodes.NewService(postgres.NewEpisodeLifecycleRepository(pool))
			keyService := apikeys.NewService(postgres.NewAPIKeyRepository(sqlc.New(pool), pool), apikeys.Config{})
			created, err := keyService.Create(context.Background(), apikeys.CreateInput{TenantID: tenantID, Name: "chain", Scopes: []authentication.Scope{authentication.ScopeEpisodesWrite}, ExpiresAt: time.Now().Add(time.Hour)})
			if err != nil {
				t.Fatal(err)
			}
			admitPattern := "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants"
			grantPattern := "/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/access-grant"
			basePath := "/v1/tenants/" + tenantID.String() + "/spaces/" + chainPathSpace.String() + "/episodes/" + chainPathEpisode.String()
			router := chi.NewRouter()
			router.Use(observability.RequestMiddleware(logger, observability.RequestLogConfig{Mode: observability.RequestLogAll}))
			router.Use(requireTenantAuthentication(keyService, ClientIPOptions{}))
			admissions := 0
			router.With(rateLimit(RateLimitOptions{Limiter: ratelimit.NewLocalLimiter(), Now: time.Now}, ratelimit.Policy{Name: "write", Limit: 1, Window: time.Minute, Cost: 1})).
				Method("POST", admitPattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					admissions++
					participant, err := episodeService.AdmitParticipant(r.Context(), episodes.AdmitParticipantInput{
						Admission: episodes.AdmissionDirect, TenantID: tenantID, SpaceID: chainPathSpace, EpisodeID: chainPathEpisode,
						ParticipantID: mustIDFromString(t, fmt.Sprintf("30000000-0000-4000-8000-%012d", admissions)), Name: "chain admission", Role: "host", Request: episodes.Request{Key: fmt.Sprintf("chain-admission-%s-%d", run, admissions)},
					})
					if err != nil {
						writeError(w, http.StatusConflict, "admission.failed", err.Error())
						return
					}
					_ = participant
					w.WriteHeader(http.StatusCreated)
				}))
			router.Method("POST", grantPattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if run == "positive" {
					observability.LogAccessGrantFailure(r.Context(), "issue", "grant_not_issued", "initial")
					writeError(w, http.StatusForbidden, "access_grant.refused", "the initial grant was not issued")
					return
				}
				w.WriteHeader(http.StatusCreated)
			}))
			bearer := func(path string) *httptest.ResponseRecorder {
				request := httptest.NewRequest("POST", path, nil)
				request.Header.Set("Authorization", "Bearer "+created.RawKey)
				recorder := httptest.NewRecorder()
				router.ServeHTTP(recorder, request)
				return recorder
			}
			// The burst: the write budget is one, so one admission lands and the rest are refused at the real limiter.
			// The healthy run stays under the budget — its one admission lands without a refusal.
			burst := 3
			if run == "healthy" {
				burst = 1
			}
			for i := 0; i < burst; i++ {
				bearer(basePath + "/participants")
			}
			if run == "positive" {
				// Fill the Episode to its participant cap: the next direct admission is refused by the repository's capacity decision.
				if _, err := pool.Exec(context.Background(), `insert into participants(id, name, metadata, capabilities, role, tenant_id, space_id, episode_id, generation, status, joined_at, left_at)
					select ('20000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid, 'capacity', '{}'::jsonb, '{subscribe}'::text[], 'host', $1, $2, $3, 1, 'active', now(), null from generate_series(2, 500) i`, tenantID.Bytes(), chainPathSpace.Bytes(), chainPathEpisode.Bytes()); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(context.Background(), `insert into participants(id, name, metadata, capabilities, role, tenant_id, space_id, episode_id, generation, status, joined_at, left_at)
					values('20000000-0000-4000-8000-000000000001'::uuid, 'departed', '{}'::jsonb, '{subscribe}'::text[], 'host', $1, $2, $3, 1, 'left', now(), now())`, tenantID.Bytes(), chainPathSpace.Bytes(), chainPathEpisode.Bytes()); err != nil {
					t.Fatal(err)
				}
				if _, err := episodeService.AdmitParticipant(context.Background(), episodes.AdmitParticipantInput{
					Admission: episodes.AdmissionDirect, TenantID: tenantID, SpaceID: chainPathSpace, EpisodeID: chainPathEpisode,
					ParticipantID: mustIDFromString(t, "30000000-0000-4000-8000-0000000000ff"), Name: "over capacity", Role: "host", Request: episodes.Request{Key: "chain-admission-capacity-" + run},
				}); !errors.Is(err, episodes.ErrCapacityExceeded) {
					t.Fatalf("capacity admission: got %v, want ErrCapacityExceeded", err)
				}
			}
			bearer(basePath + "/participants/" + chainPathParticipant.String() + "/access-grant")
			// The Tenant's follow-up operations inside the window: the key is revoked and the Episode ends.
			if err := keyService.Revoke(context.Background(), tenantID, created.Key.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := episodeService.RequestEpisodeEnd(context.Background(), episodes.RequestEpisodeEndInput{TenantID: tenantID, SpaceID: chainPathSpace, EpisodeID: chainPathEpisode, Reason: episodes.EndReasonTenantRecovery, Request: episodes.Request{Key: "chain-end-" + run}}); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(context.Background(), `update episodes set status = 'ended', ended_at = now() where tenant_id = $1 and id = $2`, tenantID.Bytes(), chainPathEpisode.Bytes()); err != nil {
				t.Fatal(err)
			}
			writeChain(t, "integration.grant_not_issued", run, chainRows(t, pool, tenantID, &capture))
		})
	}
}

// chainSeedSpaceEpisode creates the Space, its role, the artifact policy and one active Episode the admission and
// create checks run against.
func chainSeedSpaceEpisode(t *testing.T, pool *pgxpool.Pool, tenantID, spaceID, episodeID utilities.ID) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `insert into spaces(id,tenant_id,slug,name,media_plane) values($1,$2,$3,'chain','cf_sfu')`, spaceID.Bytes(), tenantID.Bytes(), spaceID.String()[:8]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,'host','{startEpisode,subscribe,publishAudio,publishVideo}'::text[])`, mustID(t).Bytes(), tenantID.Bytes(), spaceID.Bytes()); err != nil {
		t.Fatal(err)
	}
	startedAt := time.Now()
	if _, err := postgres.NewEpisodeLifecycleRepository(pool).CreateEpisode(context.Background(), episodes.CreateEpisodeInput{ID: episodeID, TenantID: tenantID, SpaceID: spaceID, StartedAt: &startedAt, ConfigSnapshot: json.RawMessage(`{"roles":{"host":["startEpisode","subscribe","publishAudio","publishVideo"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}`), Request: episodes.Request{Key: "chain-seed-episode-" + episodeID.String()[:8]}}); err != nil {
		t.Fatal(err)
	}
}

// pinRows makes the run's rows replayable. Rows sort by their non-volatile content — kernel seq stays in that
// content, so log rows keep their file order — which is stable no matter where the reader's est sort interleaves
// db rows against wall-clock log times. Ids pin in that first-seen order, millisecond fields keep their stamped
// value inside the window and land at its end outside it, latency fields pin to fixed steps, and envelope keys a
// registry row can't carry drop.
func pinRows(t *testing.T, tenantID utilities.ID, rows []map[string]any) []map[string]any {
	t.Helper()
	volatile := func(key string) bool {
		return key == "est_server_ms" || key == "latency_milliseconds" || key == "duration_ms" || key == "retry_after_ms"
	}
	strippedOf := func(row map[string]any) string {
		stripped := map[string]any{}
		for k, v := range row {
			if volatile(k) {
				continue
			}
			if k == "key_prefix" {
				stripped[k] = "prefix"
				continue
			}
			if value, ok := v.(string); ok {
				pinned := uuidPattern.ReplaceAllString(value, "id")
				stripped[k] = hexPattern.ReplaceAllString(pinned, "id")
				continue
			}
			stripped[k] = v
		}
		encoded, _ := json.Marshal(stripped)
		return string(encoded)
	}
	sorted := make([]map[string]any, 0, len(rows))
	sorted = append(sorted, rows...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return strippedOf(sorted[i]) < strippedOf(sorted[j])
	})
	identities := map[string]string{tenantID.String(): tenantID.String()}
	var order []string
	claim := func(id, kind string) {
		if id == "" || identities[id] != "" {
			return
		}
		n := len(order) + 1
		order = append(order, id)
		switch kind {
		case "uuid":
			identities[id] = fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
		case "trace":
			identities[id] = fmt.Sprintf("trace%028d", n)
		default:
			identities[id] = fmt.Sprintf("chain-prefix-%03d", n)
		}
	}
	for _, row := range sorted {
		keys := make([]string, 0, len(row))
		for k := range row {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v := row[k]
			switch value := v.(type) {
			case string:
				for _, id := range uuidPattern.FindAllString(value, -1) {
					claim(id, "uuid")
				}
				for _, id := range hexPattern.FindAllString(value, -1) {
					claim(id, "trace")
				}
				if k == "key_prefix" {
					claim("prefix:"+value, "prefix")
				}
			}
		}
	}
	lookup := func(id string) string { return identities[id] }
	logicalAt := make([]int64, 0, len(sorted))
	for _, row := range sorted {
		// The observation window a row makes derives from est_server_ms; anchor it to the row's own logical time
		// (stamped in-window) so absence proofs see the same placement the check sees, not the window's end.
		at := int64(0)
		for k, v := range row {
			if isTimeField(k) && k != "est_server_ms" {
				if value, ok := v.(float64); ok && int64(value) >= chainWindow.From.UnixMilli() && int64(value) <= chainWindow.To.UnixMilli() {
					if at == 0 || int64(value) < at {
						at = int64(value)
					}
				}
			}
		}
		if at == 0 {
			// No logical time of its own (log/request rows): place it by emission order inside the window's
			// back half — the step divides the remaining span so a large run can't push rows past its end.
			at = chainWindow.From.UnixMilli() + 180_000 + int64(len(logicalAt))*(150_000/int64(len(sorted)+1))
		}
		logicalAt = append(logicalAt, at)
	}
	pinned := make([]map[string]any, 0, len(rows))
	for i, row := range sorted {
		out := map[string]any{}
		for k, v := range row {
			if k == "source" || k == "level" || k == "msg" || k == "time" || k == "seq" {
				continue
			}
			switch value := v.(type) {
			case string:
				if k == "key_prefix" {
					out[k] = lookup("prefix:" + value)
					continue
				}
				pinned := uuidPattern.ReplaceAllStringFunc(value, lookup)
				out[k] = hexPattern.ReplaceAllStringFunc(pinned, lookup)
			case float64:
				switch {
				case k == "est_server_ms":
					out[k] = logicalAt[i]
				case isTimeField(k):
					if at := int64(value); at >= chainWindow.From.UnixMilli() && at <= chainWindow.To.UnixMilli() {
						out[k] = at
					} else {
						out[k] = chainWindow.To.UnixMilli()
					}
				case volatile(k):
					out[k] = float64(100)
				default:
					out[k] = value
				}
			default:
				out[k] = v
			}
		}
		pinned = append(pinned, out)
	}
	// The capture merges log and outbox lines at real speeds, so the row order varies run to run; the pinned rows
	// sort by their canonical encoding, and seq renumbers in that order.
	sort.Slice(pinned, func(i, j int) bool {
		a, _ := json.Marshal(pinned[i])
		b, _ := json.Marshal(pinned[j])
		return string(a) < string(b)
	})
	for i, row := range pinned {
		row["seq"] = i + 1
	}
	return pinned
}

var uuidPattern = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

var hexPattern = regexp.MustCompile(`\b[0-9a-f]{32}\b|\b[0-9a-f]{16}\b`)

func isTimeField(key string) bool {
	return strings.HasSuffix(key, "_at_ms") || key == "est_server_ms" || key == "previous_boot_end_ms" || key == "occurred_at_ms" || strings.HasSuffix(key, "_ms") && !strings.HasSuffix(key, "_milliseconds") && key != "duration_ms" && key != "retry_after_ms"
}
