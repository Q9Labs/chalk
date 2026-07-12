package httpapi_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/rooms"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSessionLifecycleHTTPFlowCommitsProductRowsAndIntents(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := openLifecycleHTTPTestPool(t, ctx)
	tenantID := newLifecycleHTTPTestID(t)
	roomID := newLifecycleHTTPTestID(t)
	user := authUser(t)
	if _, err := pool.Exec(ctx, "insert into users (id, name, email) values ($1, $2, $3) on conflict (id) do nothing", user.ID.String(), user.Name, user.Email); err != nil {
		t.Fatalf("seed lifecycle user: %v", err)
	}
	if _, err := pool.Exec(ctx, "insert into tenants (id, name) values ($1, $2)", tenantID.String(), "Lifecycle HTTP tenant"); err != nil {
		t.Fatalf("seed lifecycle tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, "insert into rooms (id, name, tenant_id, status, slug, media_plane) values ($1, $2, $3, 'active', $4, 'cf_rtk')", roomID.String(), "Lifecycle HTTP room", tenantID.String(), "lifecycle-http-"+roomID.String()); err != nil {
		t.Fatalf("seed lifecycle room: %v", err)
	}
	t.Cleanup(func() { cleanupLifecycleHTTPTest(t, pool, tenantID) })

	queries := sqlc.New(pool)
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := synctokens.NewService(synctokens.Config{Issuer: "https://api.chalk.test", Audience: "chalk-sync", KeyID: "integration-1", PrivateKey: privateKey})
	if err != nil {
		t.Fatal(err)
	}
	lifecycleRepository := postgres.NewSessionLifecycleRepository(pool)
	tokens := synctokens.NewBroker(lifecycleRepository, signer)
	options := httpapi.Options{
		Rooms:            rooms.NewService(postgres.NewRoomRepository(queries)),
		SessionLifecycle: sessionlifecycle.NewService(lifecycleRepository),
		SyncTokens:       tokens,
		SyncTokenRefresh: tokens,
	}
	createRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions", "raw-session-token", `{"metadata":{"purpose":"integration"}}`)
	createRequest.Header.Set("Idempotency-Key", "http-create-request-0001")
	createResponse := requestWithOptionsAndRequest(t, createRequest, authenticatedOptions(t, options))
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201; body=%s", createResponse.Code, createResponse.Body.String())
	}
	var created struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	decodeJSON(t, createResponse, &created)
	if created.Status != sessionlifecycle.SessionStatusActive {
		t.Fatalf("created status = %q, want active", created.Status)
	}
	retryCreateRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions", "raw-session-token", `{"metadata":{"purpose":"integration"}}`)
	retryCreateRequest.Header.Set("Idempotency-Key", "http-create-request-0001")
	retryCreateResponse := requestWithOptionsAndRequest(t, retryCreateRequest, authenticatedOptions(t, options))
	if retryCreateResponse.Code != http.StatusCreated {
		t.Fatalf("create retry status = %d, want 201; body=%s", retryCreateResponse.Code, retryCreateResponse.Body.String())
	}
	var retriedCreate struct {
		ID string `json:"id"`
	}
	decodeJSON(t, retryCreateResponse, &retriedCreate)
	if retriedCreate.ID != created.ID {
		t.Fatalf("create retry id = %s, want %s", retriedCreate.ID, created.ID)
	}
	conflictingCreateRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions", "raw-session-token", `{"metadata":{"purpose":"different"}}`)
	conflictingCreateRequest.Header.Set("Idempotency-Key", "http-create-request-0001")
	conflictingCreateResponse := requestWithOptionsAndRequest(t, conflictingCreateRequest, authenticatedOptions(t, options))
	if conflictingCreateResponse.Code != http.StatusConflict {
		t.Fatalf("create conflict status = %d, want 409; body=%s", conflictingCreateResponse.Code, conflictingCreateResponse.Body.String())
	}
	assertErrorCode(t, conflictingCreateResponse, "idempotency_conflict")
	sessionID, err := utilities.ParseID(created.ID)
	if err != nil {
		t.Fatalf("parse created session id: %v", err)
	}

	participantID := newLifecycleHTTPTestID(t)
	admitRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada","capabilities":["control"]}`)
	admitRequest.Header.Set("Idempotency-Key", "http-admit-request-0001")
	admitResponse := requestWithOptionsAndRequest(t, admitRequest, authenticatedOptions(t, options))
	if admitResponse.Code != http.StatusCreated {
		t.Fatalf("admit status = %d, want 201; body=%s", admitResponse.Code, admitResponse.Body.String())
	}
	var admission struct {
		SyncToken string `json:"sync_token"`
	}
	decodeJSON(t, admitResponse, &admission)
	if admission.SyncToken == "" {
		t.Fatal("admission sync token is empty")
	}
	refreshResponse := authenticatedRequestWithOptions(t, http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants/"+participantID.String()+"/sync-token", options)
	if refreshResponse.Code != http.StatusCreated {
		t.Fatalf("refresh status = %d, want 201; body=%s", refreshResponse.Code, refreshResponse.Body.String())
	}
	var refreshed struct {
		SyncToken string `json:"sync_token"`
	}
	decodeJSON(t, refreshResponse, &refreshed)
	if refreshed.SyncToken == "" || refreshed.SyncToken == admission.SyncToken {
		t.Fatal("refresh did not issue a distinct sync token")
	}
	conflictRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Grace","capabilities":["control"]}`)
	conflictRequest.Header.Set("Idempotency-Key", "http-admit-request-0001")
	conflictResponse := requestWithOptionsAndRequest(t, conflictRequest, authenticatedOptions(t, options))
	if conflictResponse.Code != http.StatusConflict {
		t.Fatalf("idempotency conflict status = %d, want 409; body=%s", conflictResponse.Code, conflictResponse.Body.String())
	}
	assertErrorCode(t, conflictResponse, "idempotency_conflict")

	endRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/end", "raw-session-token", "")
	endRequest.Header.Set("Idempotency-Key", "http-session-end-0001")
	endResponse := requestWithOptionsAndRequest(t, endRequest, authenticatedOptions(t, options))
	if endResponse.Code != http.StatusAccepted {
		t.Fatalf("end status = %d, want 202; body=%s", endResponse.Code, endResponse.Body.String())
	}

	var status string
	var controlRevision int64
	var intents int
	var validFingerprints int
	if err := pool.QueryRow(ctx, `
select session.status, control.control_revision, count(intent.lifecycle_intent_id), count(*) filter (where octet_length(intent.request_fingerprint) = 32)
from room_sessions session
join sync_session_control control on control.tenant_id = session.tenant_id and control.room_id = session.room_id and control.session_id = session.id
join sync_lifecycle_intents intent on intent.tenant_id = session.tenant_id and intent.room_id = session.room_id and intent.session_id = session.id
where session.tenant_id = $1 and session.room_id = $2 and session.id = $3
group by session.status, control.control_revision`, tenantID.String(), roomID.String(), sessionID.String()).Scan(&status, &controlRevision, &intents, &validFingerprints); err != nil {
		t.Fatalf("read committed lifecycle flow: %v", err)
	}
	if status != sessionlifecycle.SessionStatusEnding || controlRevision != 0 || intents != 2 || validFingerprints != 2 {
		t.Fatalf("committed lifecycle state = status %q revision %d intents %d fingerprints %d", status, controlRevision, intents, validFingerprints)
	}
}

func openLifecycleHTTPTestPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://postgres:postgres@127.0.0.1:56432/chalk_sync_overhaul?sslmode=disable"
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open lifecycle HTTP database: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping lifecycle HTTP database: %v", err)
	}
	return pool
}

func cleanupLifecycleHTTPTest(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, table := range []string{"sync_lifecycle_intents", "sync_session_control", "participants", "session_create_requests", "room_sessions", "rooms"} {
		if _, err := pool.Exec(ctx, fmt.Sprintf("delete from %s where tenant_id = $1", table), tenantID.String()); err != nil {
			t.Errorf("cleanup %s: %v", table, err)
		}
	}
	if _, err := pool.Exec(ctx, "delete from tenants where id = $1", tenantID.String()); err != nil {
		t.Errorf("cleanup tenant: %v", err)
	}
}

func newLifecycleHTTPTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("new lifecycle HTTP id: %v", err)
	}
	return id
}
