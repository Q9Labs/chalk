package postgres

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func subscribeArtifactWebhooksTx(t *testing.T, ctx context.Context, tx pgx.Tx, tenantID utilities.ID) utilities.ID {
	t.Helper()
	endpointID, revisionID := webhookIntegrationID(t), webhookIntegrationID(t)
	if _, err := tx.Exec(ctx, `insert into webhook_endpoints(id,tenant_id,name,enabled,revision,current_target_revision,current_secret_ciphertext) values($1,$2,'Artifact receiver',true,1,1,$3)`, uuid(endpointID), uuid(tenantID), []byte("encrypted-test-secret")); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `insert into webhook_endpoint_revisions(id,tenant_id,endpoint_id,revision,url_ciphertext,url_redacted,api_version,event_types) values($1,$2,$3,1,$4,'https://example.test/hook',1,$5)`, uuid(revisionID), uuid(tenantID), uuid(endpointID), []byte("encrypted-test-url"), webhooks.CoreEventTypes); err != nil {
		t.Fatal(err)
	}
	return endpointID
}

func TestArtifactWebhookSnapshotsAreOnceTransactionalAndTenantScoped(t *testing.T) {
	for _, event := range []string{"recording.started", "recording.completed", "recording.failed", "transcript.started", "transcript.completed", "transcript.failed"} {
		t.Run(event, func(t *testing.T) {
			ctx, tx, _, transcriptID, _ := newTranscriptClaimFixture(t, "transcription_finalize", "verifying", false)
			queries := sqlc.New(tx)
			var tenantID utilities.ID
			var rawTenantID string
			if err := tx.QueryRow(ctx, `select tenant_id::text from transcriptions where id=$1`, uuid(transcriptID)).Scan(&rawTenantID); err != nil {
				t.Fatal(err)
			}
			tenantID, err := utilities.ParseID(rawTenantID)
			if err != nil {
				t.Fatal(err)
			}
			row, err := queries.GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{TenantID: uuid(tenantID), ID: uuid(transcriptID)})
			if err != nil {
				t.Fatal(err)
			}
			endpointID := subscribeArtifactWebhooksTx(t, ctx, tx, tenantID)
			otherTenantID := webhookIntegrationID(t)
			if _, err := tx.Exec(ctx, `insert into tenants(id,name) values($1,'Other Tenant')`, uuid(otherTenantID)); err != nil {
				t.Fatal(err)
			}
			otherEndpointID := subscribeArtifactWebhooksTx(t, ctx, tx, otherTenantID)
			reservationID := webhookIntegrationID(t)
			if _, err := tx.Exec(ctx, `insert into recording_reservations(id,tenant_id,space_id,episode_id,recording_id,idempotency_key,request_fingerprint,participant_count,max_duration_seconds,input_bitrate_bps,state,ends_at,policy_snapshot_version) values($1,$2,$3,$4,$5,$6,$7,1,60,128000,'released',now()+interval '1 minute','episode_config.v2')`, uuid(reservationID), row.TenantID, row.SpaceID, row.EpisodeID, row.RecordingID, reservationID.String(), make([]byte, 32)); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `insert into recording_pipelines(recording_id,tenant_id,reservation_id,state,capture_epoch,capture_ready_at) values($1,$2,$3,'committed',1,now())`, row.RecordingID, row.TenantID, uuid(reservationID)); err != nil {
				t.Fatal(err)
			}
			occurredAt := time.Now().UTC().Truncate(time.Millisecond)
			status := strings.Split(event, ".")[1]
			failureCode := ""
			if status == "failed" {
				failureCode = "worker_failed"
			}
			resourceID := transcriptID
			if strings.HasPrefix(event, "recording.") {
				resourceID = id(row.RecordingID)
			}
			produce := func(transaction pgx.Tx) error {
				if strings.HasPrefix(event, "recording.") {
					_, err := produceRecordingWebhook(ctx, transaction, tenantID, resourceID, status, occurredAt, failureCode)
					return err
				}
				_, err := produceTranscriptWebhook(ctx, transaction, row, status, occurredAt, failureCode)
				return err
			}
			// A rolled-back transition must not leave a delivery or reserve the semantic key.
			rolledBack, err := tx.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err := produce(rolledBack); err != nil {
				t.Fatal(err)
			}
			if err := rolledBack.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				if err := produce(tx); err != nil {
					t.Fatal(err)
				}
			}
			var count int
			if err := tx.QueryRow(ctx, `select count(*) from webhook_events where tenant_id=$1 and event_name=$2 and resource_id=$3`, row.TenantID, event, uuid(resourceID)).Scan(&count); err != nil || count != 1 {
				t.Fatalf("events=%d error=%v", count, err)
			}
			if err := tx.QueryRow(ctx, `select count(*) from webhook_deliveries where endpoint_id=$1`, uuid(endpointID)).Scan(&count); err != nil || count != 1 {
				t.Fatalf("deliveries=%d error=%v", count, err)
			}
			if err := tx.QueryRow(ctx, `select count(*) from webhook_deliveries where endpoint_id=$1`, uuid(otherEndpointID)).Scan(&count); err != nil || count != 0 {
				t.Fatalf("cross-Tenant deliveries=%d error=%v", count, err)
			}
			var body []byte
			if err := tx.QueryRow(ctx, `select body from webhook_events where tenant_id=$1 and event_name=$2 and resource_id=$3`, row.TenantID, event, uuid(resourceID)).Scan(&body); err != nil {
				t.Fatal(err)
			}
			var payload struct {
				Event    string `json:"event"`
				TenantID string `json:"tenant_id"`
				Data     struct {
					Object struct {
						ID          string                    `json:"id"`
						SpaceID     string                    `json:"space_id"`
						EpisodeID   string                    `json:"episode_id"`
						RecordingID string                    `json:"recording_id"`
						Status      string                    `json:"status"`
						CompletedAt *string                   `json:"completed_at"`
						Failure     *webhooks.ArtifactFailure `json:"failure"`
					} `json:"object"`
				} `json:"data"`
			}
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Fatal(err)
			}
			object := payload.Data.Object
			if payload.Event != event || payload.TenantID != tenantID.String() || object.ID != resourceID.String() || object.SpaceID != id(row.SpaceID).String() || object.EpisodeID != id(row.EpisodeID).String() || object.Status != status {
				t.Fatalf("wrong public snapshot: %s", body)
			}
			if strings.HasPrefix(event, "transcript.") && object.RecordingID != id(row.RecordingID).String() {
				t.Fatalf("missing Recording identity: %s", body)
			}
			if status == "completed" && object.CompletedAt == nil {
				t.Fatal("missing completion time")
			}
			if status == "failed" && (object.Failure == nil || object.Failure.Code != failureCode) {
				t.Fatal("missing bounded failure code")
			}
			if strings.Contains(string(body), "storage_key") || strings.Contains(string(body), "secret") {
				t.Fatal("private storage or credential leaked")
			}
		})
	}
}
