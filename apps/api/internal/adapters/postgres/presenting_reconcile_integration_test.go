package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingRenderInvoker struct {
	mu   sync.Mutex
	jobs []utilities.ID
}

func (r *recordingRenderInvoker) Invoke(_ context.Context, input presenting.InvokeInput) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.jobs = append(r.jobs, input.JobID)
	return nil
}

func (r *recordingRenderInvoker) invoked() []utilities.ID {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]utilities.ID(nil), r.jobs...)
}

func insertFailedDocumentJob(t *testing.T, repository PresentingRepository, fixture presentingTestFixture, documentID, jobID utilities.ID) {
	t.Helper()
	mustExec(t, repository.db, `insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status,failure_code,failure_message)
		values($1,$2,$3,$4,$5,$6,1,'deck.pdf','application/pdf',1024,'terminal-source',repeat('b',32)::bytea,'failed','corrupt','failed in test')`,
		uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(documentID), uuid(newTestID(t)), uuid(fixture.participant))
	mustExec(t, repository.db, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
		values($1,$2,$3,$4,'pages',1,1,'queued',now()-interval '1 minute')`, uuid(fixture.tenant), uuid(fixture.space), uuid(documentID), uuid(jobID))
}

func TestPresentingClaimFailsJobForTerminalDocumentIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	documentID, jobID := newTestID(t), newTestID(t)
	insertFailedDocumentJob(t, repository, fixture, documentID, jobID)
	token, _ := utilities.NewID()
	now := time.Now().UTC()
	_, err := repository.ClaimRenderJob(ctx, jobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if !errors.Is(err, presenting.ErrNoRenderJob) {
		t.Fatalf("terminal document claim error = %v", err)
	}
	var status, code string
	if err := pool.QueryRow(ctx, `select status,error_code from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(fixture.tenant), uuid(fixture.space), uuid(documentID), uuid(jobID)).Scan(&status, &code); err != nil {
		t.Fatalf("read terminal job: %v", err)
	}
	if status != "failed" || code != "document_terminal" {
		t.Fatalf("terminal document job after claim rejection status=%q code=%q", status, code)
	}
}

func TestPresentingReconcileSkipsTerminalDocumentJobsIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	mustExec(t, pool, `with terminal_documents as (
		insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status,failure_code,failure_message)
		select $1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,1,'deck.pdf','application/pdf',1024,'terminal-'||g,repeat('b',32)::bytea,'failed','corrupt','failed in test'
		from generate_series(1,60) g
		returning tenant_id,space_id,document_id
	)
	insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
	select tenant_id,space_id,document_id,gen_random_uuid(),'pages',1,1,'queued',now()-interval '1 minute'
	from terminal_documents`, uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(fixture.participant))
	mustExec(t, pool, `with timeout_document as (
		insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status)
		values($1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,1,'timeout-deck.pdf','application/pdf',1024,'timeout-source',repeat('c',32)::bytea,'preparing')
		returning tenant_id,space_id,document_id
	), expired_inventory as (
		insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,attempt_count,attempt_limit,lease_token,lease_owner,lease_expires_at,available_at)
		select tenant_id,space_id,document_id,gen_random_uuid(),'inventory',1,1,'leased',1,1,gen_random_uuid(),'document-renderer',now()-interval '2 minutes',now()-interval '3 minutes'
		from timeout_document
		returning job_id
	)
	insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
	select tenant_id,space_id,document_id,gen_random_uuid(),'pages',g,g,'queued',now()-interval '1 minute'
	from timeout_document, generate_series(1,10) g`, uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(fixture.participant))
	good, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create good document: %v", err)
	}
	invoker := &recordingRenderInvoker{}
	signer, err := presenting.NewCapabilitySigner(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	service := presenting.NewService(repository, nil, invoker).WithCapabilitySigner(signer).WithAvailability(func(context.Context) bool { return true })
	stale, invoked, err := service.ReconcileRenderJobs(ctx, presenting.ReconcileBatchLimit)
	if err != nil {
		t.Fatalf("reconcile render jobs: %v", err)
	}
	if stale != 1 || invoked != 1 {
		t.Fatalf("reconcile stale=%d invoked=%d; want one good job only", stale, invoked)
	}
	invokedJobs := invoker.invoked()
	if len(invokedJobs) != 1 || invokedJobs[0] != good.InventoryJobID {
		t.Fatalf("invoked jobs = %+v, want only good inventory job %s", invokedJobs, good.InventoryJobID)
	}
	var terminalCount int
	if err := pool.QueryRow(ctx, `select count(*) from presenting_render_jobs where tenant_id=$1 and space_id=$2 and status='failed' and error_code='document_terminal'`, uuid(fixture.tenant), uuid(fixture.space)).Scan(&terminalCount); err != nil {
		t.Fatalf("count terminal jobs: %v", err)
	}
	if terminalCount != 60 {
		t.Fatalf("terminal sweep marked %d jobs; want 60", terminalCount)
	}
	var activeSiblingCount int
	if err := pool.QueryRow(ctx, `select count(*) from presenting_render_jobs job
		join presenting_documents document on document.tenant_id=job.tenant_id and document.space_id=job.space_id and document.document_id=job.document_id
		where job.tenant_id=$1 and job.space_id=$2 and document.failure_code='timeout' and job.kind='pages' and job.status='queued'`, uuid(fixture.tenant), uuid(fixture.space)).Scan(&activeSiblingCount); err != nil {
		t.Fatalf("count active sibling jobs: %v", err)
	}
	if activeSiblingCount != 10 {
		t.Fatalf("active sibling jobs after same-statement exclusion = %d; want the 10 seeded siblings still queued but not selected", activeSiblingCount)
	}
}
