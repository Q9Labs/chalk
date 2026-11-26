package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPresentingRenderCompletionIsAtomicWithDocumentReadinessIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	jobID := newTestID(t)
	mustExec(t, pool, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
		values($1,$2,$3,$4,'pages',1,1,'queued',now())`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID), uuid(jobID))
	now := time.Now().UTC()
	token, _ := utilities.NewID()
	claimed, err := repository.ClaimRenderJob(ctx, jobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim page job: %v", err)
	}
	lease := claimed.Job.RenderLease
	mustExec(t, pool, `update presenting_documents set page_count=1 where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	mustExec(t, pool, `insert into presenting_document_pages(tenant_id,space_id,document_id,page,width,height,status,image_key,thumbnail_key)
		values($1,$2,$3,1,1600,900,'ready','test-image','test-thumbnail')`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	mustExec(t, pool, `create or replace function presenting_test_abort_ready_completion() returns trigger language plpgsql as $$
begin
	if NEW.status = 'ready' and OLD.status is distinct from 'ready' then
		raise exception 'presenting test abort ready completion';
	end if;
	return NEW;
end
$$`)
	mustExec(t, pool, `create trigger presenting_test_abort_ready_completion before update on presenting_documents for each row execute function presenting_test_abort_ready_completion()`)
	t.Cleanup(func() {
		mustExec(t, pool, `drop trigger if exists presenting_test_abort_ready_completion on presenting_documents`)
		mustExec(t, pool, `drop function if exists presenting_test_abort_ready_completion()`)
	})

	if err := repository.CompleteRenderJob(ctx, lease); err == nil {
		t.Fatal("completion unexpectedly succeeded past the document trigger")
	}
	var jobStatus, documentStatus string
	if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&jobStatus); err != nil {
		t.Fatalf("read job status: %v", err)
	}
	if err := pool.QueryRow(ctx, `select status from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID)).Scan(&documentStatus); err != nil {
		t.Fatalf("read document status: %v", err)
	}
	if jobStatus != "leased" || documentStatus != "preparing" {
		t.Fatalf("interrupted completion left job=%q document=%q", jobStatus, documentStatus)
	}
}
