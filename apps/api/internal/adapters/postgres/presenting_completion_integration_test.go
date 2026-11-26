package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/presenting"
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
	now := time.Now().UTC()
	inventoryToken, _ := utilities.NewID()
	inventoryClaim, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, 1, now, now.Add(time.Minute), inventoryToken, "document-renderer")
	if err != nil {
		t.Fatalf("claim inventory job: %v", err)
	}
	inventoryLease := inventoryClaim.Job.RenderLease
	trackTestUploads(t, repository, inventoryLease, 1)
	jobs, err := repository.CompleteInventory(ctx, presenting.InventoryReport{Lease: inventoryLease, PageCount: 2, Pages: []presenting.PageSpec{{Page: 1, Width: 1600, Height: 900}, {Page: 2, Width: 1600, Height: 900}}}, 25)
	if err != nil {
		t.Fatalf("complete inventory: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("inventory queued page jobs %+v; want one", jobs)
	}
	pageToken, _ := utilities.NewID()
	now = time.Now().UTC()
	claimed, err := repository.ClaimRenderJob(ctx, jobs[0].JobID, 1, now, now.Add(time.Minute), pageToken, "document-renderer")
	if err != nil {
		t.Fatalf("claim page job: %v", err)
	}
	lease := claimed.Job.RenderLease
	mustExec(t, pool, `update presenting_document_pages set status='ready',image_key='test-image',thumbnail_key='test-thumbnail' where tenant_id=$1 and space_id=$2 and document_id=$3 and page=2`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
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

func TestPresentingLateRenderCallbackAfterDocumentDeleteReturnsLeaseLostIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	lease := presenting.RenderLease{TenantID: document.TenantID, SpaceID: document.SpaceID, DocumentID: document.DocumentID, JobID: document.InventoryJobID, Attempt: 1, LeaseToken: newTestID(t), LeaseOwner: "document-renderer"}
	mustExec(t, pool, `delete from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	if err := repository.CompleteRenderJob(ctx, lease); !errors.Is(err, presenting.ErrLeaseLost) {
		t.Fatalf("late completion error = %v; want lease lost", err)
	}
	if err := repository.FailRenderJob(ctx, lease, presenting.RenderFailure{Code: "corrupt", Message: "late"}); !errors.Is(err, presenting.ErrLeaseLost) {
		t.Fatalf("late failure error = %v; want lease lost", err)
	}
}
