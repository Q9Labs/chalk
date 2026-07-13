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
	createBody := `{"metadata":{"purpose":"integration"},"admission_policy":"open","host_exit_policy":"promote_cohost","role_capabilities":{"host":["subscribe","transferHost","endMeeting"],"cohost":["subscribe"],"participant":["subscribe"]},"maximum_duration_seconds":3600}`
	createRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions", "raw-session-token", createBody)
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
	retryCreateRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions", "raw-session-token", createBody)
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
	conflictingCreateRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions", "raw-session-token", `{"metadata":{"purpose":"different"},"admission_policy":"open","host_exit_policy":"promote_cohost","role_capabilities":{"host":["subscribe","transferHost","endMeeting"],"cohost":["subscribe"],"participant":["subscribe"]},"maximum_duration_seconds":3600}`)
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
	admitRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Ada","initial_role":"cohost","eligible_roles":["cohost","participant"]}`)
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
	if refreshResponse.Code != http.StatusNotFound {
		t.Fatalf("refresh before applied join status = %d, want 404; body=%s", refreshResponse.Code, refreshResponse.Body.String())
	}
	assertErrorCode(t, refreshResponse, "participant_not_found")
	var joinIntentID string
	if err := pool.QueryRow(ctx, `select lifecycle_intent_id from sync_lifecycle_intents where tenant_id = $1 and session_id = $2 and participant_session_id = $3 and intent_name = 'participant_joined'`, tenantID.String(), sessionID.String(), participantID.String()).Scan(&joinIntentID); err != nil {
		t.Fatalf("read join intent: %v", err)
	}
	eventID := newLifecycleHTTPTestID(t)
	if _, err := pool.Exec(ctx, `
insert into sync_control_events (
  tenant_id, room_id, session_id, event_id, base_revision, revision, event_name, payload,
	  lifecycle_intent_id, event_schema_version, resulting_state_digest, encoded_bytes
) values ($1, $2, $3, $4, 0, 1, 'participant_joined', '{}'::jsonb, $5, 3, decode(repeat('00', 32), 'hex'), 2)`,
		tenantID.String(), roomID.String(), sessionID.String(), eventID.String(), joinIntentID); err != nil {
		t.Fatalf("insert participant join fact: %v", err)
	}
	if _, err := pool.Exec(ctx, `update participants set status = 'active', joined_at = now(), updated_at = now() where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4`, tenantID.String(), roomID.String(), sessionID.String(), participantID.String()); err != nil {
		t.Fatalf("apply participant product state: %v", err)
	}
	if _, err := pool.Exec(ctx, `update sync_lifecycle_intents set status = 'applied', applied_event_id = $1, applied_revision = 1, completed_at = now() where tenant_id = $2 and room_id = $3 and session_id = $4 and lifecycle_intent_id = $5`, eventID.String(), tenantID.String(), roomID.String(), sessionID.String(), joinIntentID); err != nil {
		t.Fatalf("complete participant join intent: %v", err)
	}
	refreshResponse = authenticatedRequestWithOptions(t, http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants/"+participantID.String()+"/sync-token", options)
	if refreshResponse.Code != http.StatusCreated {
		t.Fatalf("refresh after applied join status = %d, want 201; body=%s", refreshResponse.Code, refreshResponse.Body.String())
	}
	var refreshed struct {
		SyncToken string `json:"sync_token"`
	}
	decodeJSON(t, refreshResponse, &refreshed)
	if refreshed.SyncToken == "" || refreshed.SyncToken == admission.SyncToken {
		t.Fatal("refresh after applied join did not issue a distinct sync token")
	}
	conflictRequest := bearerRequestWithBody(http.MethodPost, "/v1/tenants/"+tenantID.String()+"/rooms/"+roomID.String()+"/sessions/"+sessionID.String()+"/participants", "raw-session-token", `{"participant_session_id":"`+participantID.String()+`","name":"Grace","initial_role":"cohost","eligible_roles":["cohost","participant"]}`)
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
	var externalOperations int
	if err := pool.QueryRow(ctx, `
select session.status, control.control_revision,
       (select count(*) from sync_lifecycle_intents intent where intent.tenant_id = session.tenant_id and intent.session_id = session.id),
       (select count(*) from sync_lifecycle_intents intent where intent.tenant_id = session.tenant_id and intent.session_id = session.id and octet_length(intent.request_fingerprint) = 32),
       (select count(*) from sync_external_operations operation where operation.tenant_id = session.tenant_id and operation.session_id = session.id and operation.operation_name = 'tenant_end_session')
from room_sessions session
join sync_session_control control on control.tenant_id = session.tenant_id and control.room_id = session.room_id and control.session_id = session.id
where session.tenant_id = $1 and session.room_id = $2 and session.id = $3
`, tenantID.String(), roomID.String(), sessionID.String()).Scan(&status, &controlRevision, &intents, &validFingerprints, &externalOperations); err != nil {
		t.Fatalf("read committed lifecycle flow: %v", err)
	}
	if status != sessionlifecycle.SessionStatusEnding || controlRevision != 0 || intents != 1 || validFingerprints != 1 || externalOperations != 1 {
		t.Fatalf("committed lifecycle state = status %q revision %d intents %d fingerprints %d external operations %d", status, controlRevision, intents, validFingerprints, externalOperations)
	}
}

func openLifecycleHTTPTestPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"
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
	if _, err := pool.Exec(ctx, `update sync_lifecycle_intents set status = 'pending', applied_event_id = null, applied_revision = null, completed_at = null where tenant_id = $1 and status = 'applied'`, tenantID.String()); err != nil {
		t.Errorf("detach applied lifecycle intents: %v", err)
	}
	for _, table := range []string{"sync_command_receipts", "sync_control_events", "sync_admission_requests", "sync_recordings", "sync_publication_fences", "sync_publication_grant_reservations", "sync_external_operations", "sync_lifecycle_intents", "sync_session_control", "participants", "session_create_requests", "room_sessions", "rooms"} {
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
