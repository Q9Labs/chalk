package postgres

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingExpiryBody struct {
	Source struct {
		Status    string  `json:"status"`
		ExpiresAt *string `json:"expires_at"`
	} `json:"source"`
	TranscriptionPreparation struct {
		Status    string  `json:"status"`
		ExpiresAt *string `json:"expires_at"`
	} `json:"transcription_preparation"`
}

// A client can close "make a transcript" on time only if the Recording says
// when its transcription source expires, which is usually long before the video.
func TestGetRecordingExposesTranscriptionSourceExpiry(t *testing.T) {
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
	if _, err := connection.Exec(ctx, `insert into tenants (id, name) values ($1, 'Transcription expiry fixture')`, tenantID.Bytes()); err != nil {
		t.Fatal(err)
	}
	defer cleanupTranscriptPolicyFixture(t, ctx, connection, tenantID)
	defer func() {
		if _, err := connection.Exec(ctx, `delete from api_keys where tenant_id = $1`, tenantID.Bytes()); err != nil {
			t.Errorf("delete fixture API keys: %v", err)
		}
	}()
	onDemand := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
	insertTranscriptPolicyCaptureCompleteFixture(t, ctx, connection, tenantID, onDemand)
	insertTranscriptSourceFixture(t, ctx, connection, tenantID, onDemand)
	disabled := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "disabled", false)
	insertTranscriptPolicyCaptureCompleteFixture(t, ctx, connection, tenantID, disabled)
	insertTranscriptSourceFixture(t, ctx, connection, tenantID, disabled)

	queries := sqlc.New(pool)
	keys := apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{})
	key, err := keys.Create(ctx, apikeys.CreateInput{
		TenantID:  tenantID,
		Name:      "Transcription expiry fixture",
		Scopes:    []authentication.Scope{authentication.ScopeRecordingsRead},
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
		APIKeyAuthentication: keys,
		TenantAuthz:          authorization.NewTenantPolicy(nil, nil),
		Recordings:           recordings.NewService(NewRecordingRepository(queries)),
		RecordingExports:     recordingpipeline.NewService(NewRecordingPipelineRepository(queries)),
	}))
	defer server.Close()

	get := func(recordingID utilities.ID) recordingExpiryBody {
		t.Helper()
		path := "/v1/tenants/" + tenantID.String() + "/recordings/" + recordingID.String()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
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
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: status=%d body=%s", path, response.StatusCode, raw)
		}
		var body recordingExpiryBody
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	stored := func(recordingID utilities.ID) time.Time {
		t.Helper()
		var expiresAt time.Time
		if err := connection.QueryRow(ctx, `select expires_at from recording_transcription_sources where recording_id = $1`, recordingID.Bytes()).Scan(&expiresAt); err != nil {
			t.Fatal(err)
		}
		return expiresAt
	}
	parse := func(value *string) time.Time {
		t.Helper()
		if value == nil {
			t.Fatal("expiry is missing")
		}
		parsed, err := time.Parse(time.RFC3339Nano, *value)
		if err != nil {
			t.Fatal(err)
		}
		return parsed
	}

	open := get(onDemand)
	if open.TranscriptionPreparation.Status != string(recordingpipeline.TranscriptionPreparationReady) || !parse(open.TranscriptionPreparation.ExpiresAt).Equal(stored(onDemand)) {
		t.Fatalf("open transcription source = %+v, want ready until %s", open.TranscriptionPreparation, stored(onDemand))
	}
	if open.Source.Status != string(recordingpipeline.SourceStatusAvailable) || !parse(open.TranscriptionPreparation.ExpiresAt).Before(parse(open.Source.ExpiresAt)) {
		t.Fatalf("transcription expiry %v should precede the open video source %+v", open.TranscriptionPreparation.ExpiresAt, open.Source)
	}

	if _, err := connection.Exec(ctx, `update recording_transcription_sources set committed_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where recording_id = $1`, onDemand.Bytes()); err != nil {
		t.Fatal(err)
	}
	closed := get(onDemand)
	if closed.TranscriptionPreparation.Status != string(recordingpipeline.TranscriptionPreparationExpired) || !parse(closed.TranscriptionPreparation.ExpiresAt).Equal(stored(onDemand)) {
		t.Fatalf("closed transcription source = %+v, want expired at %s", closed.TranscriptionPreparation, stored(onDemand))
	}
	if closed.Source.Status != string(recordingpipeline.SourceStatusAvailable) {
		t.Fatalf("video source = %+v, want it to stay available after the transcription source closes", closed.Source)
	}

	if off := get(disabled); off.TranscriptionPreparation.Status != string(recordingpipeline.TranscriptionPreparationNone) || off.TranscriptionPreparation.ExpiresAt != nil {
		t.Fatalf("disabled transcription = %+v, want none with no expiry", off.TranscriptionPreparation)
	}
}
