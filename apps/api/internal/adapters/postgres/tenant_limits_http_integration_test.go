package postgres

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/recordingorchestrator"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type tenantLimitPeer struct{}

func (tenantLimitPeer) Verify(*http.Request) error { return nil }

type tenantLimitFixture struct {
	pool   *pgxpool.Pool
	tenant utilities.ID
}

func newTenantLimitFixture(t *testing.T, pool *pgxpool.Pool) tenantLimitFixture {
	t.Helper()
	f := tenantLimitFixture{pool: pool, tenant: accountTenantIntegrationID(t)}
	if _, err := pool.Exec(t.Context(), `insert into tenants(id,name) values($1,'Tenant limits test')`, uuid(f.tenant)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `insert into tenant_artifact_policies(tenant_id) values($1)`, uuid(f.tenant)); err != nil {
		t.Fatal(err)
	}
	return f
}
func (f tenantLimitFixture) space(t *testing.T) utilities.ID {
	t.Helper()
	id := accountTenantIntegrationID(t)
	if _, err := f.pool.Exec(t.Context(), `insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Tenant limits Space',$3,'cf_sfu')`, uuid(id), uuid(f.tenant), id.String()); err != nil {
		t.Fatal(err)
	}
	for _, role := range spaces.DefaultRoles() {
		if _, err := f.pool.Exec(t.Context(), `insert into space_roles(id,tenant_id,space_id,name,capabilities) values($1,$2,$3,$4,$5)`, uuid(accountTenantIntegrationID(t)), uuid(f.tenant), uuid(id), role.Name, role.Capabilities); err != nil {
			t.Fatal(err)
		}
	}
	return id
}
func (f tenantLimitFixture) episode(t *testing.T, space utilities.ID) utilities.ID {
	t.Helper()
	id := accountTenantIntegrationID(t)
	if _, err := f.pool.Exec(t.Context(), `insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'active','{}')`, uuid(id), uuid(f.tenant), uuid(space)); err != nil {
		t.Fatal(err)
	}
	return id
}
func TestTenantRecordingLimitsHTTP(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	f, other := newTenantLimitFixture(t, pool), newTenantLimitFixture(t, pool)
	space, otherSpace := f.space(t), other.space(t)
	episode, otherEpisode := f.episode(t, space), other.episode(t, otherSpace)
	now := time.Now().UTC()
	repo := NewRecordingPipelineRepositoryWithPool(pool)
	repo.now = func() time.Time { return now }
	makeRouter := func(limits tenantlimits.Config) http.Handler {
		pipeline := recordingpipeline.NewService(repo.WithTenantLimits(limits))
		controller := recordingorchestrator.NewController(pipeline)
		bridge := providerbridge.NewService(NewProviderOperationRepositoryWithPool(pool), providerbridge.NewSFUExecutor(nil, nil, controller))
		return httpapi.NewProviderBridgeHandler(bridge, tenantLimitPeer{})
	}
	request := func(router http.Handler, tenant, space, episode, recording utilities.ID, operation string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"effect":"recording.start","tenant_id":%q,"episode_id":%q,"recording_id":%q,"recording_reservation":{"space_id":%q,"participant_count":1,"max_duration_seconds":7200,"input_bitrate_bps":1000000,"policy_snapshot_version":"episode_config.v2"}}`, tenant.String(), episode.String(), recording.String(), space.String())
		r := httptest.NewRequest(http.MethodPost, "/internal/v1/sync/provider-operations/"+operation, bytes.NewBufferString(body))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	start := func(router http.Handler, fixture tenantLimitFixture, space, episode utilities.ID) (*httptest.ResponseRecorder, utilities.ID, string) {
		recording, operation := accountTenantIntegrationID(t), accountTenantIntegrationID(t).String()
		return request(router, fixture.tenant, space, episode, recording, operation), recording, operation
	}
	assertOutcome := func(t *testing.T, w *httptest.ResponseRecorder, want string) {
		t.Helper()
		var body struct {
			Outcome string `json:"outcome"`
			Reason  string `json:"reason"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if (want == "confirmed" && (w.Code != 200 || body.Outcome != want)) || (want != "confirmed" && (w.Code != 409 || body.Reason != tenantlimits.RecordingLimitReason || !bytes.Contains(w.Body.Bytes(), []byte(`"code":"tenant.recording_limit_reached"`)))) {
			t.Fatalf("status=%d body=%s want=%s", w.Code, w.Body.String(), want)
		}
	}
	// Disabled settings preserve admission and bridge responses for multiple recordings.
	unlimited := makeRouter(tenantlimits.Config{})
	a, firstRecording, firstOperation := start(unlimited, f, space, episode)
	assertOutcome(t, a, "confirmed")
	b, _, _ := start(unlimited, f, space, episode)
	assertOutcome(t, b, "confirmed")
	limited := makeRouter(tenantlimits.Config{ManagedPublicTenantID: other.tenant, MaxConcurrentRecordings: 1})
	assertOutcome(t, request(limited, f.tenant, space, episode, firstRecording, firstOperation), "confirmed")
	rejected, rejectedID, rejectedOp := start(limited, f, space, episode)
	assertOutcome(t, rejected, "tenant.recording_limit_reached")
	isolated, _, _ := start(limited, other, otherSpace, otherEpisode)
	assertOutcome(t, isolated, "confirmed")
	// A rejected command has a durable terminal receipt, but creates no recording work.
	for _, table := range []string{"recordings", "recording_reservations", "recording_pipelines", "recording_jobs"} {
		column := "recording_id"
		if table == "recordings" {
			column = "id"
		}
		var count int
		if err := pool.QueryRow(ctx, "select count(*) from "+table+" where "+column+"=$1", uuid(rejectedID)).Scan(&count); err != nil || count != 0 {
			t.Fatalf("partial %s rows=%d err=%v", table, count, err)
		}
	}
	assertOutcome(t, request(limited, f.tenant, space, episode, rejectedID, rejectedOp), "tenant.recording_limit_reached")
	// Release reserved fixture work to leave shared global capacity unchanged.
	release := func(tenant utilities.ID) {
		rows, err := pool.Query(ctx, `select id from recording_reservations where tenant_id=$1 and state='reserved'`, uuid(tenant))
		if err != nil {
			t.Fatal(err)
		}
		var ids []utilities.ID
		for rows.Next() {
			var id utilities.ID
			var raw [16]byte
			if err := rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			id = utilities.IDFromBytes(raw)
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		for _, id := range ids {
			if _, err := repo.ReleaseReservation(ctx, tenant, id, recordingpipeline.ReservationStateReleased); err != nil {
				t.Fatal(err)
			}
		}
	}
	release(f.tenant)
	release(other.tenant)
	// Two real HTTP starts race for one tenant slot. The capacity lock serializes admission.
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 2)
	gate := make(chan struct{})
	for i := 0; i < 2; i++ {
		recording, operation := accountTenantIntegrationID(t), accountTenantIntegrationID(t).String()
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-gate
			results <- request(limited, f.tenant, space, episode, recording, operation)
		}()
	}
	close(gate)
	wg.Wait()
	close(results)
	confirmed, rejectedCount := 0, 0
	for w := range results {
		var body struct {
			Outcome string `json:"outcome"`
			Reason  string `json:"reason"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if w.Code == 200 && body.Outcome == "confirmed" {
			confirmed++
		} else if w.Code == 409 && body.Reason == tenantlimits.RecordingLimitReason {
			rejectedCount++
		} else {
			t.Fatalf("race response: %d %s", w.Code, w.Body.String())
		}
	}
	if confirmed != 1 || rejectedCount != 1 {
		t.Fatalf("race confirmed=%d rejected=%d", confirmed, rejectedCount)
	}
	now = now.Truncate(24 * time.Hour).Add(12 * time.Hour)
	if _, err := pool.Exec(ctx, `update recording_reservations set created_at=$2,ends_at=$3 where tenant_id=$1 and state='reserved'`, uuid(f.tenant), now.Add(-2*time.Minute), now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	activeDaily := makeRouter(tenantlimits.Config{ManagedPublicTenantID: other.tenant, DailyRecordingMinutes: 1})
	activeRejected, _, _ := start(activeDaily, f, space, episode)
	assertOutcome(t, activeRejected, "tenant.recording_limit_reached")

	for _, tc := range []struct {
		name   string
		limits tenantlimits.Config
	}{
		{"managed public concurrent recordings", tenantlimits.Config{ManagedPublicTenantID: f.tenant, MaxConcurrentRecordings: 1}},
		{"managed public daily minutes", tenantlimits.Config{ManagedPublicTenantID: f.tenant, DailyRecordingMinutes: 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := makeRouter(tc.limits)
			for i := 0; i < 2; i++ {
				accepted, _, _ := start(router, f, space, episode)
				assertOutcome(t, accepted, "confirmed")
			}
		})
	}
	release(f.tenant)
	// Charge a finished capture that started today, not time spent rendering/transcribing.
	if _, err := pool.Exec(ctx, `update recording_reservations set created_at=$2,updated_at=$3,ends_at=$3 where tenant_id=$1`, uuid(f.tenant), now.Add(-10*time.Minute), now); err != nil {
		t.Fatal(err)
	}
	daily := makeRouter(tenantlimits.Config{ManagedPublicTenantID: other.tenant, DailyRecordingMinutes: 1})
	w, _, _ := start(daily, f, space, episode)
	assertOutcome(t, w, "tenant.recording_limit_reached")
	now = now.Add(24 * time.Hour)
	w, _, _ = start(daily, f, space, episode)
	assertOutcome(t, w, "confirmed")
	release(f.tenant)
}

func TestTenantLiveEpisodeLimitsHTTP(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	f := newTenantLimitFixture(t, pool)
	keys := apikeys.NewService(NewAPIKeyRepository(sqlc.New(pool), pool), apikeys.Config{})
	key, err := keys.Create(ctx, apikeys.CreateInput{TenantID: f.tenant, Name: "Tenant limits", Scopes: []authentication.Scope{authentication.ScopeEpisodesWrite}, ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	router := httpapi.NewRouter(httpapi.Options{Episodes: episodes.NewService(NewEpisodeLifecycleRepository(pool).WithTenantLimits(tenantlimits.Config{MaxLiveEpisodes: 3})), APIKeyAuthentication: keys, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
	request := func(space utilities.ID, keyID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+f.tenant.String()+"/spaces/"+space.String()+"/episodes", bytes.NewBufferString(`{}`))
		r.Header.Set("Authorization", "Bearer "+key.RawKey)
		r.Header.Set("Idempotency-Key", keyID)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	for i := 0; i < 3; i++ {
		w := request(f.space(t), accountTenantIntegrationID(t).String())
		if w.Code != 201 {
			t.Fatalf("start=%d %s", w.Code, w.Body.String())
		}
	}
	space := f.space(t)
	requestKey := accountTenantIntegrationID(t).String()
	w := request(space, requestKey)
	if w.Code != 409 || !bytes.Contains(w.Body.Bytes(), []byte("tenant.live_episode_limit_reached")) {
		t.Fatalf("limit=%d %s", w.Code, w.Body.String())
	}
	for _, table := range []string{"episodes", "episode_create_requests", "sync_episode_control", "sync_external_operations"} {
		var count int
		if err := pool.QueryRow(ctx, "select count(*) from "+table+" where tenant_id=$1 and space_id=$2", uuid(f.tenant), uuid(space)).Scan(&count); err != nil || count != 0 {
			t.Fatalf("partial %s=%d err=%v", table, count, err)
		}
	}
	if _, err := pool.Exec(ctx, `update episodes set status='ended',ended_at=now() where id=(select id from episodes where tenant_id=$1 limit 1)`, uuid(f.tenant)); err != nil {
		t.Fatal(err)
	}
	// Race for the newly freed last slot in different Spaces.
	space2 := f.space(t)
	key2 := accountTenantIntegrationID(t).String()
	results := make(chan *httptest.ResponseRecorder, 2)
	gate := make(chan struct{})
	var wg sync.WaitGroup
	for _, input := range []struct {
		space utilities.ID
		key   string
	}{{space, requestKey}, {space2, key2}} {
		wg.Add(1)
		go func() { defer wg.Done(); <-gate; results <- request(input.space, input.key) }()
	}
	close(gate)
	wg.Wait()
	close(results)
	successes, rejections := 0, 0
	for w := range results {
		if w.Code == 201 {
			successes++
		} else if w.Code == 409 && bytes.Contains(w.Body.Bytes(), []byte("tenant.live_episode_limit_reached")) {
			rejections++
		} else {
			t.Fatalf("race=%d %s", w.Code, w.Body.String())
		}
	}
	if successes != 1 || rejections != 1 {
		t.Fatalf("race successes=%d rejections=%d", successes, rejections)
	}
}

func TestManagedPublicTenantLiveEpisodeLimitsPublicJoin(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	managed := newTenantLimitFixture(t, pool)
	normal := newTenantLimitFixture(t, pool)
	service := episodes.NewService(NewEpisodeLifecycleRepository(pool).WithTenantLimits(tenantlimits.Config{
		ManagedPublicTenantID: managed.tenant, MaxLiveEpisodes: 1,
	}))
	for _, tc := range []struct {
		name    string
		fixture tenantLimitFixture
		limited bool
	}{{"normal", normal, true}, {"managed public", managed, false}} {
		t.Run(tc.name, func(t *testing.T) {
			for i := 0; i < 3; i++ {
				result, err := service.JoinPublic(t.Context(), episodes.PublicJoinInput{
					TenantID: tc.fixture.tenant, SpaceID: tc.fixture.space(t),
					IdentityMode: "guest", DisplayName: "Guest", Role: "collaborator",
					Request: episodes.Request{Key: accountTenantIntegrationID(t).String()},
				})
				if tc.limited && i > 0 {
					if !errors.Is(err, tenantlimits.ErrLiveEpisodeLimitReached) {
						t.Fatalf("join %d: want live Episode limit, got %v", i, err)
					}
				} else if err != nil || !result.EpisodeCreated {
					t.Fatalf("join %d: created=%v err=%v", i, result.EpisodeCreated, err)
				}
			}
		})
	}
}
