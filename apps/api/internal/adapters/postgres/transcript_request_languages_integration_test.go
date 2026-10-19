package postgres

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

const publishedContractPath = "../../../../../contract/generated/openapi.json"

// publishedTranscriptLanguagesMinItems reads the Transcript schema that the
// SDKs are generated from, so the test compares the engine with the contract
// callers actually receive.
func publishedTranscriptLanguagesMinItems(t *testing.T) int {
	t.Helper()
	raw, err := os.ReadFile(publishedContractPath)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Components struct {
			Schemas map[string]struct {
				Properties map[string]struct {
					MinItems int `json:"minItems"`
				} `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	return document.Components.Schemas["Transcript"].Properties["languages"].MinItems
}

// Omitting languages asks the provider to detect them, and the engine stores
// an empty list until it does. The accepted response must satisfy the same
// Transcript schema the generated clients validate it against.
func TestRequestTranscriptWithoutLanguagesMatchesPublishedContract(t *testing.T) {
	databaseURL := os.Getenv(config.DatabaseURL)
	if testing.Short() || databaseURL == "" {
		t.Skip("isolated PostgreSQL integration database is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()

	tenantID := mustTenantPolicyTestID(t)
	if _, err := connection.Exec(ctx, `insert into tenants (id, name) values ($1, 'Transcript languages contract fixture')`, tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	defer cleanupTranscriptPolicyFixture(t, ctx, connection, tenantID)
	defer func() {
		if _, err := connection.Exec(ctx, `delete from api_keys where tenant_id = $1`, tenantID.Bytes()); err != nil {
			t.Errorf("delete fixture API keys: %v", err)
		}
	}()
	recordingID := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
	if _, err := connection.Exec(ctx, `update recordings set status = 'pending', completed_at = null where id = $1`, recordingID.Bytes()); err != nil {
		t.Fatal(err)
	}
	insertTranscriptSourceFixture(t, ctx, connection, tenantID, recordingID)

	queries := sqlc.New(pool)
	keys := apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{})
	key, err := keys.Create(ctx, apikeys.CreateInput{
		TenantID:  tenantID,
		Name:      "Transcript languages contract fixture",
		Scopes:    []authentication.Scope{authentication.ScopeTranscriptionsWrite},
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
		APIKeyAuthentication: keys,
		TenantAuthz:          authorization.NewTenantPolicy(nil, nil),
		TranscriptArtifacts:  transcripts.NewService(NewTranscriptRepositoryWithPool(queries, pool)),
	}))
	defer server.Close()

	path := "/v1/tenants/" + tenantID.String() + "/recordings/" + recordingID.String() + "/transcripts"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+path, strings.NewReader(`{"idempotency_key":"languages-omitted-0001"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+key.RawKey)
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("POST %s: status=%d want=%d body=%s", path, response.StatusCode, http.StatusAccepted, raw)
	}
	var accepted struct {
		Transcript struct {
			Languages *[]string `json:"languages"`
		} `json:"transcript"`
	}
	if err := json.Unmarshal(raw, &accepted); err != nil {
		t.Fatal(err)
	}
	if accepted.Transcript.Languages == nil {
		t.Fatalf("accepted Transcript has no languages array: %s", raw)
	}
	if got, want := len(*accepted.Transcript.Languages), publishedTranscriptLanguagesMinItems(t); got < want {
		t.Fatalf("accepted Transcript has %d languages but the published Transcript schema requires at least %d: %s", got, want, raw)
	}
}
