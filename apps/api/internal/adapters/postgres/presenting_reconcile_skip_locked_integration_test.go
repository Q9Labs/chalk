package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/presenting"
)

func TestPresentingReconcileSkipsLockedTerminalJobIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	t.Cleanup(func() {
		mustExec(t, pool, `delete from presenting_render_jobs where tenant_id=$1 and space_id=$2`, uuid(fixture.tenant), uuid(fixture.space))
	})
	terminalAttachmentID := insertAdditionalPresentingAttachment(t, pool, fixture)
	terminalDocumentID, lockedJobID := newTestID(t), newTestID(t)
	mustExec(t, pool, `insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status,failure_code,failure_message,page_count)
		values($1,$2,$3,$4,$5,$6,1,'deck.pdf','application/pdf',1024,'locked-terminal-source',repeat('b',32)::bytea,'failed','corrupt','failed in test',10)`,
		uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(terminalDocumentID), uuid(terminalAttachmentID), uuid(fixture.participant))
	mustExec(t, pool, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
		values($1,$2,$3,$4,'pages',1,1,'queued',now()-interval '1 minute')`, uuid(fixture.tenant), uuid(fixture.space), uuid(terminalDocumentID), uuid(lockedJobID))
	good, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create good document: %v", err)
	}
	lockTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin terminal job lock transaction: %v", err)
	}
	defer lockTx.Rollback(ctx)
	var locked string
	if err := lockTx.QueryRow(ctx, `select job_id::text from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4 for update`, uuid(fixture.tenant), uuid(fixture.space), uuid(terminalDocumentID), uuid(lockedJobID)).Scan(&locked); err != nil {
		t.Fatalf("lock terminal job: %v", err)
	}
	invoker := &recordingRenderInvoker{}
	signer, err := presenting.NewCapabilitySigner(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	service := presenting.NewService(repository, nil, invoker).WithCapabilitySigner(signer).WithAvailability(func(context.Context) bool { return true })
	reconcileCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, _, err := service.ReconcileRenderJobs(reconcileCtx, 1000); err != nil {
		t.Fatalf("reconcile with locked terminal job: %v", err)
	}
	invokedJobs := invoker.invoked()
	goodInvoked, lockedInvoked := false, false
	for _, jobID := range invokedJobs {
		goodInvoked = goodInvoked || jobID == good.InventoryJobID
		lockedInvoked = lockedInvoked || jobID == lockedJobID
	}
	if !goodInvoked {
		t.Fatalf("invoked jobs %+v do not include unrelated good inventory job %s", invokedJobs, good.InventoryJobID)
	}
	if lockedInvoked {
		t.Fatalf("invoked jobs %+v include locked terminal job %s", invokedJobs, lockedJobID)
	}
	var status string
	if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(fixture.tenant), uuid(fixture.space), uuid(terminalDocumentID), uuid(lockedJobID)).Scan(&status); err != nil {
		t.Fatalf("read locked terminal job: %v", err)
	}
	if status != "queued" {
		t.Fatalf("locked terminal job status = %q; want queued because SKIP LOCKED skipped the sweep", status)
	}
}
