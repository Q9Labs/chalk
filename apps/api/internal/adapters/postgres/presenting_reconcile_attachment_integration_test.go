package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/presenting"
)

func TestPresentingReconcileWaitsForSourceAttachmentCommitIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	cleanupPresentingRenderJobsForFixture(t, pool, fixture)
	attachmentID, documentID, jobID := newTestID(t), newTestID(t), newTestID(t)
	mustExec(t, pool, `insert into sync_chat_attachments(tenant_id,space_id,episode_id,attachment_id,participant_id,participant_generation,client_attachment_id,request_fingerprint,upload_id,object_key,original_filename,mime_type,byte_length,sha256,immutable_object_identity,status,expires_at,finalized_at)
		values($1,$2,$3,$4,$5,1,'commit-race-client',repeat('a',32)::bytea,gen_random_uuid(),'commit-race-'||gen_random_uuid()::text,'deck.pdf','application/pdf',1024,repeat('b',32)::bytea,'object-version','ready',now()-interval '1 minute',now())`,
		uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(attachmentID), uuid(fixture.participant))
	mustExec(t, pool, `insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status)
		values($1,$2,$3,$4,$5,$6,1,'deck.pdf','application/pdf',1024,'commit-race-source',repeat('b',32)::bytea,'preparing')`,
		uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(documentID), uuid(attachmentID), uuid(fixture.participant))
	mustExec(t, pool, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
		values($1,$2,$3,$4,'inventory',1,1,'queued',timestamp '2000-01-01')`, uuid(fixture.tenant), uuid(fixture.space), uuid(documentID), uuid(jobID))
	attachmentTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = attachmentTx.Rollback(context.Background()) })
	if _, err := attachmentTx.Exec(ctx, `select attachment_id from sync_chat_attachments where tenant_id=$1 and space_id=$2 and attachment_id=$3 for update`, uuid(fixture.tenant), uuid(fixture.space), uuid(attachmentID)); err != nil {
		t.Fatalf("lock source attachment: %v", err)
	}
	invoker := &recordingRenderInvoker{}
	signer, err := presenting.NewCapabilitySigner(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	scopedRepository := tenantScopedReconcileRepository{Repository: repository, tenantID: fixture.tenant, spaceID: fixture.space}
	service := presenting.NewService(scopedRepository, nil, invoker).WithCapabilitySigner(signer).WithAvailability(func(context.Context) bool { return true })
	reconcileDone := make(chan error, 1)
	go func() {
		_, _, err := service.ReconcileRenderJobs(ctx, presenting.ReconcileBatchLimit)
		reconcileDone <- err
	}()
	blocked := false
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		var waiting int
		if err := pool.QueryRow(ctx, `select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%with attachment_keys%'`).Scan(&waiting); err == nil && waiting > 0 {
			blocked = true
			break
		}
	}
	if !blocked {
		t.Fatal("reconcile did not wait on the source attachment lock")
	}
	if _, err := attachmentTx.Exec(ctx, `insert into sync_chat_messages(tenant_id,space_id,episode_id,sequence,message_id,participant_id,participant_generation,client_message_id,request_fingerprint,display_name,message_text,encoded_bytes,created_at)
		values($1,$2,$3,999999,gen_random_uuid(),$4,1,'commit-race-message',repeat('c',32)::bytea,'Presenter','',1,now())`, uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(fixture.participant)); err != nil {
		t.Fatalf("commit-time chat message insert: %v", err)
	}
	if _, err := attachmentTx.Exec(ctx, `update sync_chat_attachments set status='attached',message_sequence=999999,message_ordinal=4,attached_at=now() where tenant_id=$1 and space_id=$2 and attachment_id=$3`, uuid(fixture.tenant), uuid(fixture.space), uuid(attachmentID)); err != nil {
		t.Fatalf("commit-time attachment update: %v", err)
	}
	if err := attachmentTx.Commit(ctx); err != nil {
		t.Fatalf("commit source attachment: %v", err)
	}
	if err := <-reconcileDone; err != nil {
		t.Fatalf("reconcile after source attachment commit: %v", err)
	}
	var status, code string
	if err := pool.QueryRow(ctx, `select status,coalesce(error_code,'') from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(fixture.tenant), uuid(fixture.space), uuid(documentID), uuid(jobID)).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != "queued" || code != "" {
		t.Fatalf("job after attachment commit status=%q code=%q; want queued without source_expired", status, code)
	}
}
