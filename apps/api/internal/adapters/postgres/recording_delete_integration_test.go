package postgres_test

import (
	"context"
	"crypto/sha256"
	"sort"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingDeleteObjectFake struct {
	objects map[string][]byte
	deleted []string
}

func newRecordingDeleteObjectFake(keys ...string) *recordingDeleteObjectFake {
	fake := &recordingDeleteObjectFake{objects: map[string][]byte{}}
	for _, key := range keys {
		fake.objects[key] = []byte("object")
	}
	return fake
}

func (f *recordingDeleteObjectFake) DeleteObject(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	if _, ok := f.objects[key]; !ok {
		return objectstorage.ErrObjectNotFound
	}
	delete(f.objects, key)
	return nil
}

func (f *recordingDeleteObjectFake) PutObject(context.Context, objectstorage.PutObjectInput) (objectstorage.Object, error) {
	return objectstorage.Object{}, objectstorage.ErrStoreUnavailable
}
func (f *recordingDeleteObjectFake) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	return objectstorage.ObjectReader{}, objectstorage.ErrStoreUnavailable
}
func (f *recordingDeleteObjectFake) InspectObject(context.Context, string) (objectstorage.ObjectFacts, error) {
	return objectstorage.ObjectFacts{}, objectstorage.ErrStoreUnavailable
}
func (f *recordingDeleteObjectFake) CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, objectstorage.ErrStoreUnavailable
}
func (f *recordingDeleteObjectFake) CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, objectstorage.ErrStoreUnavailable
}
func (f *recordingDeleteObjectFake) CreateDeleteURL(context.Context, objectstorage.CreateDeleteURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, objectstorage.ErrStoreUnavailable
}

func TestRecordingDeleteRemovesObjectsTombstonesAndPublishesOnce(t *testing.T) {
	ctx := t.Context()
	tx, fixture := newAllocationCleanupFixture(t, false, "render")
	defer tx.Rollback(ctx)
	execCleanupFixture(t, tx, `update recording_jobs set state = 'succeeded', terminal_at = now(), lease_token = null, lease_owner = null, lease_expires_at = null where id = $1`, fixture.jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_pipelines set state = 'committed' where recording_id = $1`, fixture.recordingID.Bytes())

	var tenant pgtype.UUID
	if err := tx.QueryRow(ctx, `select tenant_id from recordings where id = $1`, fixture.recordingID.Bytes()).Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	tenantID := utilities.IDFromBytes(tenant.Bytes)
	prefix := "tenants/" + tenantID.String() + "/recordings/"
	exportKey := prefix + fixture.recordingID.String() + "/render/1/recording_video/export.mp4"
	transcriptKey := prefix + fixture.recordingID.String() + "/transcripts/artifact.json"
	digest := sha256.Sum256([]byte("recording delete fixture"))
	execCleanupFixture(t, tx, `update recordings set storage_key = $1, storage_content_type = 'video/mp4', storage_size = 1, storage_checksum = $2, duration_millis = 1000, metadata = '{"private":true}'::jsonb where id = $3`, exportKey, digest[:], fixture.recordingID.Bytes())
	execCleanupFixture(t, tx, `insert into recording_artifacts (recording_id, tenant_id, render_job_id, object_key, content_type, byte_size, checksum, duration_millis, committed_at) values ($1, $2, $3, $4, 'video/mp4', 1, $5, 1000, now())`, fixture.recordingID.Bytes(), tenant.Bytes, fixture.jobID.Bytes(), exportKey, digest[:])
	transcriptID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	execCleanupFixture(t, tx, `insert into transcriptions (id, tenant_id, recording_id, space_id, episode_id, status, languages, artifact_key, artifact_sha256, artifact_size, artifact_content_type, completed_at)
		select $1, tenant_id, id, space_id, episode_id, 'complete', array['en'], $2, $3, 1, 'application/json', now() from recordings where id = $4`, transcriptID.Bytes(), transcriptKey, digest[:], fixture.recordingID.Bytes())
	execCleanupFixture(t, tx, `insert into webhook_endpoints (id, tenant_id, name, enabled, revision, current_target_revision, current_secret_ciphertext) values (gen_random_uuid(), $1, 'delete subscriber', true, 1, 1, '\x01')`, tenant.Bytes)
	execCleanupFixture(t, tx, `insert into webhook_endpoint_revisions (id, tenant_id, endpoint_id, revision, url_ciphertext, url_redacted, api_version, event_types)
		select gen_random_uuid(), tenant_id, id, 1, '\x01', 'https://subscriber.invalid', 1, array['recording.deleted', 'transcript.deleted'] from webhook_endpoints where tenant_id = $1`, tenant.Bytes)

	keys := append([]string{exportKey, transcriptKey, "fixtures/presentation.json", "fixtures/assets.json", fixture.sourceKey}, fixture.orphanKeys...)
	store := newRecordingDeleteObjectFake(keys...)
	objects := objectstorage.NewService(store)
	repository := postgres.NewRecordingRepositoryWithPool(sqlc.New(tx), nestedTransactor{tx})
	service := recordings.NewService(repository).WithObjectDeleter(objects)
	input := struct {
		tenant, recording utilities.ID
	}{tenantID, fixture.recordingID}

	if err := service.Delete(ctx, input.tenant, input.recording, "api_key:55555555-5555-4555-8555-555555555555"); err != nil {
		t.Fatalf("delete recording: %v", err)
	}
	if err := service.Delete(ctx, input.tenant, input.recording, "api_key:55555555-5555-4555-8555-555555555555"); err != nil {
		t.Fatalf("repeat delete recording: %v", err)
	}

	if len(store.objects) != 0 {
		remaining := make([]string, 0, len(store.objects))
		for key := range store.objects {
			remaining = append(remaining, key)
		}
		sort.Strings(remaining)
		t.Fatalf("recording objects remain: %v", remaining)
	}
	deletedCount := len(store.deleted)
	if deletedCount != len(keys) {
		t.Fatalf("object delete calls = %d, want one for each of %d keys: %v", deletedCount, len(keys), store.deleted)
	}

	var status, actor string
	var deletedAt, storageKey, metadata any
	if err := tx.QueryRow(ctx, `select status, deleted_by, deleted_at, storage_key, metadata from recordings where id = $1`, fixture.recordingID.Bytes()).Scan(&status, &actor, &deletedAt, &storageKey, &metadata); err != nil {
		t.Fatal(err)
	}
	if status != "deleted" || actor != "api_key:55555555-5555-4555-8555-555555555555" || deletedAt == nil || storageKey != nil || metadata != nil {
		t.Fatalf("tombstone = status:%q actor:%q deleted_at:%v storage_key:%v metadata:%v", status, actor, deletedAt, storageKey, metadata)
	}
	var transcriptArtifact *string
	var transcriptStatus string
	if err := tx.QueryRow(ctx, `select status, artifact_key from transcriptions where id = $1`, transcriptID.Bytes()).Scan(&transcriptStatus, &transcriptArtifact); err != nil {
		t.Fatal(err)
	}
	if transcriptStatus != "deleted" || transcriptArtifact != nil {
		t.Fatalf("transcript tombstone = status:%q artifact:%v", transcriptStatus, transcriptArtifact)
	}

	for _, event := range []string{"recording.deleted", "transcript.deleted"} {
		var events, deliveries int
		if err := tx.QueryRow(ctx, `select count(distinct event.id), count(delivery.id) from webhook_events event left join webhook_deliveries delivery on delivery.event_id = event.id where event.tenant_id = $1 and event.event_name = $2`, tenant.Bytes, event).Scan(&events, &deliveries); err != nil {
			t.Fatal(err)
		}
		if events != 1 || deliveries != 1 {
			t.Fatalf("%s events/deliveries = %d/%d, want exactly one after two deletes", event, events, deliveries)
		}
	}
	if _, err := repository.Get(ctx, tenantID, fixture.recordingID); err != recordings.ErrRecordingNotFound {
		t.Fatalf("public get after delete err = %v, want recording not found", err)
	}
}

func TestRecordingDeleteRejectsActiveWorkWithoutDeletingObjects(t *testing.T) {
	ctx := t.Context()
	tx, fixture := newAllocationCleanupFixture(t, false, "render")
	defer tx.Rollback(ctx)
	var tenant pgtype.UUID
	if err := tx.QueryRow(ctx, `select tenant_id from recordings where id = $1`, fixture.recordingID.Bytes()).Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	store := newRecordingDeleteObjectFake(fixture.orphanKeys...)
	objects := objectstorage.NewService(store)
	repository := postgres.NewRecordingRepositoryWithPool(sqlc.New(tx), nestedTransactor{tx})
	service := recordings.NewService(repository).WithObjectDeleter(objects)
	err := service.Delete(ctx, utilities.IDFromBytes(tenant.Bytes), fixture.recordingID, "api_key:55555555-5555-4555-8555-555555555555")
	if err != recordings.ErrRecordingDeleteConflict {
		t.Fatalf("delete err = %v, want delete conflict", err)
	}
	if len(store.deleted) != 0 || len(store.objects) != len(fixture.orphanKeys) {
		t.Fatalf("active delete touched objects: deleted=%v remaining=%v", store.deleted, store.objects)
	}
	var status string
	if err := tx.QueryRow(ctx, `select status from recordings where id = $1`, fixture.recordingID.Bytes()).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "completed" {
		t.Fatalf("recording status = %q, want unchanged completed", status)
	}
}
