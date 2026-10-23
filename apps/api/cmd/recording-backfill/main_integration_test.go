package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestBackfillCommandPersistsExportedTraceLinks(t *testing.T) {
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		t.Skip("CHALK_DATABASE_URL is not set")
	}
	ctx := context.Background() // The operator command has no incoming trace.
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	newID := func() utilities.ID {
		id, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	tenantID, spaceID, episodeID, recordingID := newID(), newID(), newID(), newID()
	reservationID, captureID, presentationID := newID(), newID(), newID()
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, statement, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Error(err)
			return
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `delete from observability_journey_events where attributes->>'tenant_id'=$1`, tenantID.String()); err != nil {
			t.Error(err)
			return
		}
		for _, table := range []string{"recording_presentations", "recording_presentation_sources", "recording_presentation_baselines", "recording_data_keys", "recording_bundles"} {
			if _, err := tx.Exec(ctx, "alter table "+table+" disable trigger user"); err != nil {
				t.Error(err)
				return
			}
			if _, err := tx.Exec(ctx, "delete from "+table+" where tenant_id=$1", tenantID.Bytes()); err != nil {
				t.Error(err)
				return
			}
			if _, err := tx.Exec(ctx, "alter table "+table+" enable trigger user"); err != nil {
				t.Error(err)
				return
			}
		}
		for _, table := range []string{"recording_jobs", "recording_pipelines", "recording_reservations", "recordings", "episodes", "spaces"} {
			if _, err := tx.Exec(ctx, "delete from "+table+" where tenant_id=$1", tenantID.Bytes()); err != nil {
				t.Error(err)
				return
			}
		}
		if _, err := tx.Exec(ctx, "delete from tenants where id=$1", tenantID.Bytes()); err != nil {
			t.Error(err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			t.Error(err)
		}
	}()
	exec(`insert into tenants(id,name,recording_render_mode) values($1,'Backfill trace fixture','automatic')`, tenantID.Bytes())
	exec(`insert into spaces(id,tenant_id,name,slug,media_plane) values($1,$2,'Backfill trace fixture',$3,'cf_sfu')`, spaceID.Bytes(), tenantID.Bytes(), spaceID.String())
	exec(`insert into episodes(id,tenant_id,space_id,status,config_snapshot) values($1,$2,$3,'ended','{}')`, episodeID.Bytes(), tenantID.Bytes(), spaceID.Bytes())
	exec(`insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values($1,$2,$3,$4,'processing','r2')`, recordingID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes())
	exec(`insert into recording_reservations(id,tenant_id,space_id,episode_id,recording_id,idempotency_key,request_fingerprint,participant_count,max_duration_seconds,input_bitrate_bps,state,ends_at,policy_snapshot_version) values($1,$2,$3,$4,$5,$6,$7,1,60,100000,'released',now(),'episode_config.v2')`, reservationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), reservationID.String(), make([]byte, 32))
	exec(`insert into recording_pipelines(recording_id,tenant_id,reservation_id,state,capture_epoch,capture_completed_at) values($1,$2,$3,'capture_complete',1,now())`, recordingID.Bytes(), tenantID.Bytes(), reservationID.Bytes())
	exec(`insert into recording_jobs(id,tenant_id,episode_id,recording_id,kind,idempotency_key,payload_schema_version,state,attempt_limit,available_at) values($1,$2,$3,$4,'capture',$5,1,'succeeded',3,now())`, captureID.Bytes(), tenantID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), captureID.String())
	exec(`insert into recording_data_keys(recording_id,capture_epoch,tenant_id,episode_id,job_id,attempt_count,fencing_generation,key_handle,environment,envelope_digest,encryption_context_digest,ciphertext_blob) values($1,1,$2,$3,$4,1,1,$5,'local',$6,$6,$6)`, recordingID.Bytes(), tenantID.Bytes(), episodeID.Bytes(), captureID.Bytes(), newID().Bytes(), make([]byte, 32))
	exec(`insert into recording_bundles(id,tenant_id,recording_id,capture_job_id,sequence_number,fencing_generation,object_key,content_type,codec,byte_size,checksum,monotonic_start_millis,monotonic_end_millis,media_start_millis,media_end_millis) values($1,$2,$3,$4,0,1,'bundle','audio/ogg','opus',1,$5,0,1000,0,1000)`, newID().Bytes(), tenantID.Bytes(), recordingID.Bytes(), captureID.Bytes(), make([]byte, 32))
	exec(`insert into recording_presentation_baselines(presentation_handle,tenant_id,space_id,episode_id,recording_id,schema_version,profile_version,profile,space_name,episode_control_revision,episode_folded_state,participant_facts,chat_head_sequence,baseline_at) values($1,$2,$3,$4,$5,'recording_presentation.v1','test','{"version":"test"}','Test',0,'{}','[]',0,now())`, presentationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes())
	exec(`insert into recording_presentation_sources(presentation_handle,tenant_id,space_id,episode_id,recording_id,capture_epoch,capture_ready_at,episode_control_start_revision,episode_control_events,episode_control_end_revision,participant_facts,chat_start_sequence,initial_chat_messages,whiteboard_start_revision,whiteboard_events,whiteboard_end_revision,capture_plan_start_revision) values($1,$2,$3,$4,$5,1,now(),0,'[]',0,'[]',0,'[]',0,'[]',0,0)`, presentationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes())
	exec(`insert into recording_presentations(presentation_handle,tenant_id,space_id,episode_id,recording_id,capture_epoch,schema_version,profile_version,duration_millis,presentation_sha256,presentation_object_key,presentation_object_version,presentation_object_etag,presentation_content_type,presentation_byte_size,asset_manifest_object_key,asset_manifest_object_version,asset_manifest_object_etag,asset_manifest_content_type,asset_manifest_byte_size,asset_manifest_sha256,frozen_at) values($1,$2,$3,$4,$5,1,'recording_presentation.v1','test',1000,$6,'presentation','v1','etag','application/json',1,'assets','v1','etag','application/json',1,$6,now())`, presentationID.Bytes(), tenantID.Bytes(), spaceID.Bytes(), episodeID.Bytes(), recordingID.Bytes(), make([]byte, 32))

	var mu sync.Mutex
	var exported []*tracepb.Span
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodHead {
			w.Header().Set("Content-Length", "1")
			return
		}
		if req.URL.Path == "/v1/traces" {
			body, err := io.ReadAll(req.Body)
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			var request collectortrace.ExportTraceServiceRequest
			if err := proto.Unmarshal(body, &request); err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, resource := range request.ResourceSpans {
				for _, scope := range resource.ScopeSpans {
					exported = append(exported, scope.Spans...)
				}
			}
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer server.Close()
	t.Setenv(config.R2Endpoint, server.URL)
	t.Setenv(config.R2Bucket, "backfill-test")
	t.Setenv(config.R2AccessKeyID, "test")
	t.Setenv(config.R2SecretAccessKey, "test")
	t.Setenv(config.APIOTLPEndpoint, server.URL)
	t.Setenv(config.APIOTLPInsecure, "true")
	previous := otel.GetTracerProvider()
	defer otel.SetTracerProvider(previous)
	var output bytes.Buffer
	if err := run(ctx, []string{"--batch-size", "100", "--apply"}, &output); err != nil {
		t.Fatal(err)
	}
	var result report
	if err := json.Unmarshal(output.Bytes(), &result); err != nil || result.Queued != 1 {
		t.Fatalf("backfill did not queue the fixture: %s err=%v", output.String(), err)
	}
	var jobID, journeyID, traceID, spanID string
	if err := pool.QueryRow(ctx, `select jobs.id::text,events.journey_id::text,events.trace_id,events.span_id from recording_jobs jobs join observability_journey_events events on events.event_id=jobs.id where jobs.recording_id=$1 and jobs.kind='render' and events.name='recording.render.queued' and events.attributes->>'trigger'='backfill'`, recordingID.Bytes()).Scan(&jobID, &journeyID, &traceID, &spanID); err != nil {
		t.Fatal(err)
	}
	if journeyID == recordingID.String() {
		t.Fatal("backfill event must use the command journey, not the legacy recording-ID fallback")
	}
	mu.Lock()
	defer mu.Unlock()
	var parentSpanID string
	for _, span := range exported {
		if span.Name == "recording.render.backfill" && hex.EncodeToString(span.TraceId) == traceID {
			for _, attr := range span.Attributes {
				if attr.Key == "chalk.journey.id" && attr.Value.GetStringValue() == journeyID {
					parentSpanID = hex.EncodeToString(span.SpanId)
				}
			}
		}
	}
	for _, span := range exported {
		if span.Name == "recording.render.backfill.queue" && hex.EncodeToString(span.TraceId) == traceID && hex.EncodeToString(span.SpanId) == spanID && parentSpanID != "" && hex.EncodeToString(span.ParentSpanId) == parentSpanID {
			for _, attr := range span.Attributes {
				if attr.Key == "recording.job.id" && attr.Value.GetStringValue() == jobID {
					return
				}
			}
		}
	}
	t.Fatalf("backfill event does not link to its exported job span: job=%s trace=%s span=%s spans=%d", jobID, traceID, spanID, len(exported))
}
