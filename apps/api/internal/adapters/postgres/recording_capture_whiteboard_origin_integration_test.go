package postgres_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func TestRecordingCompletionWithWhiteboardReceiptsAroundCaptureReady(t *testing.T) {
	ctx := context.Background()
	tx, fixture := newAllocationCleanupFixtureWithMode(t, false, "capture", "on_demand", false)
	defer tx.Rollback(ctx)
	exec := func(query string, args ...any) {
		t.Helper()
		execCleanupFixture(t, tx, query, args...)
	}

	var tenant, space, episode pgtype.UUID
	var baseline time.Time
	if err := tx.QueryRow(ctx, `select tenant_id, space_id, episode_id, baseline_at
		from recording_presentation_baselines where recording_id = $1`, fixture.recordingID.Bytes()).Scan(&tenant, &space, &episode, &baseline); err != nil {
		t.Fatal(err)
	}
	readyAt := pgtype.Timestamptz{Time: baseline.Add(4 * time.Second), Valid: true}
	exec(`update recording_pipelines set capture_ready_at = $2 where recording_id = $1`, fixture.recordingID.Bytes(), readyAt)
	exec(`insert into participants (id, tenant_id, space_id, episode_id, capabilities, generation, status, role)
		values (gen_random_uuid(), $1, $2, $3, '{drawWhiteboard}', 1, 'active', 'collaborator')`, tenant, space, episode)
	exec(`insert into sync_whiteboard_scenes (tenant_id, space_id, episode_id, scene_id)
		values ($1, $2, $3, gen_random_uuid())`, tenant, space, episode)
	exec(`insert into sync_whiteboard_operation_receipts (
		tenant_id, space_id, episode_id, participant_id, submitted_generation, operation_id,
		request_fingerprint, operation_name, outcome, scene_id, revision, event_elements,
		event_presenting, event_encoded_bytes, completed_at
	)
	select p.tenant_id, p.space_id, p.episode_id, p.id, p.generation, 'capture-receipt-' || event.revision,
		$2, event.operation, 'committed', s.scene_id, event.revision, event.elements,
		event.presenting, coalesce(octet_length(event.elements::text), 0), $1::timestamptz + event.time_offset
	from participants p join sync_whiteboard_scenes s using (tenant_id, space_id, episode_id)
	cross join (values
		(1, 'clear', null::jsonb, null::boolean, interval '-3 seconds'),
		(2, 'set_presentation', null, true, interval '-2 seconds'),
		(3, 'set_draw_permission', null, null, interval '-1 second'),
		(4, 'submit_update', '[{"payload":{"fileId":"capture-image"}}]'::jsonb, null, interval '-500 milliseconds'),
		(5, 'clear', null, null, interval '100 milliseconds'),
		(6, 'set_presentation', null, false, interval '200 milliseconds'),
		(7, 'set_draw_permission', null, null, interval '300 milliseconds')
	) event(revision, operation, elements, presenting, time_offset)
	where p.tenant_id = $3`, readyAt, fixture.digest, tenant)
	exec(`insert into sync_whiteboard_files (
		upload_id, tenant_id, space_id, episode_id, scene_id, participant_id, participant_generation,
		file_id, object_key, mime_type, byte_length, sha256, expires_at, status, immutable_object_identity, finalized_at
	) select gen_random_uuid(), p.tenant_id, p.space_id, p.episode_id, s.scene_id, p.id, p.generation,
		'capture-image', p.id::text, 'image/png', 1, $1, now() + interval '1 hour', 'ready', 'fixture', now()
	from participants p join sync_whiteboard_scenes s using (tenant_id, space_id, episode_id)
	where p.tenant_id = $2`, fixture.digest, tenant)
	exec(`insert into recording_bundles (id, tenant_id, recording_id, capture_job_id, sequence_number,
		fencing_generation, object_key, content_type, codec, byte_size, checksum,
		monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis)
		values (gen_random_uuid(), $1, $2, $3, 0, 1, 'fixture', 'application/json', 'opus', 1, $4, 0, 1000, 0, 1000)`,
		tenant, fixture.recordingID.Bytes(), fixture.jobID.Bytes(), fixture.digest)

	assertReceipts := func(t *testing.T, encoded []byte, count int) {
		t.Helper()
		var events []struct {
			OperationName string            `json:"operation_name"`
			Elements      []json.RawMessage `json:"elements"`
		}
		if err := json.Unmarshal(encoded, &events); err != nil || len(events) != count {
			t.Fatalf("expected %d whiteboard receipts, got %s: %v", count, encoded, err)
		}
		for _, event := range events {
			if event.Elements == nil || (event.OperationName != "submit_update" && len(event.Elements) != 0) {
				t.Errorf("%s must store elements as an array, got %v", event.OperationName, event.Elements)
			}
		}
	}
	var frozenOrigin []byte
	for _, legacy := range []bool{false, true} {
		name := "new origin"
		if legacy {
			name = "previously frozen null elements"
		}
		t.Run(name, func(t *testing.T) {
			savepoint, err := tx.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer savepoint.Rollback(ctx)
			queries := sqlc.New(savepoint)
			if legacy {
				if len(frozenOrigin) == 0 {
					t.Fatal("new capture origin was not seeded")
				}
				execCleanupFixture(t, savepoint, `insert into recording_presentation_sources
					select (jsonb_populate_record(null::recording_presentation_sources,
						jsonb_set($1::jsonb, '{whiteboard_events,0,elements}', 'null'::jsonb))).*`, frozenOrigin)
			} else {
				frozen, err := queries.InsertRecordingPresentationSource(ctx, sqlc.InsertRecordingPresentationSourceParams{
					TenantID: tenant, SpaceID: space, EpisodeID: episode, RecordingID: cleanupUUID(fixture.recordingID),
					CaptureEpoch: fixture.captureEpoch, CaptureReadyAt: readyAt,
				})
				if err != nil {
					t.Fatal(err)
				}
				assertReceipts(t, frozen.WhiteboardEvents, 4)
				err = savepoint.QueryRow(ctx, `select to_jsonb(source) from recording_presentation_sources source
					where recording_id = $1`, fixture.recordingID.Bytes()).Scan(&frozenOrigin)
				if err != nil {
					t.Fatal(err)
				}
			}
			source, err := queries.GetRecordingPresentationCompletionSource(ctx, sqlc.GetRecordingPresentationCompletionSourceParams{
				JobID: cleanupUUID(fixture.jobID), AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: fixture.captureEpoch,
				EnvelopeDigest: fixture.digest, LeaseToken: fixture.leaseToken, LeaseOwner: fixture.leaseOwner,
			})
			if err != nil {
				t.Fatalf("valid whiteboard receipts must not block recording completion: %v", err)
			}
			assertReceipts(t, []byte(source.WhiteboardTailEventsJson), 3)
			var files []json.RawMessage
			if err := json.Unmarshal([]byte(source.WhiteboardFilesJson), &files); err != nil || len(files) != 1 || source.DurationMillis != 1000 {
				t.Fatalf("expected the recorded second and the referenced image, got %dms and %s: %v", source.DurationMillis, source.WhiteboardFilesJson, err)
			}
		})
	}
}
