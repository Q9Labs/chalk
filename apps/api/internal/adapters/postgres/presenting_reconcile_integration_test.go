package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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

func insertAdditionalPresentingAttachment(t *testing.T, pool *pgxpool.Pool, fixture presentingTestFixture) utilities.ID {
	t.Helper()
	attachmentID, uploadID := newTestID(t), newTestID(t)
	mustExec(t, pool, `insert into sync_chat_attachments(tenant_id,space_id,episode_id,attachment_id,participant_id,participant_generation,client_attachment_id,request_fingerprint,upload_id,object_key,original_filename,mime_type,byte_length,sha256,immutable_object_identity,status,expires_at,finalized_at)
		values($1,$2,$3,$4,$5,1,$6,repeat('a',32)::bytea,$7,$8,'deck.pdf','application/pdf',1024,repeat('b',32)::bytea,'object-version','ready',now()+interval '1 day',now())`,
		uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(attachmentID), uuid(fixture.participant), "client-"+attachmentID.String(), uuid(uploadID), "attachment-"+attachmentID.String())
	return attachmentID
}

func clearPresentingRenderJobsForSerialTest(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	// Reconciliation and untargeted claims are global. These integration tests
	// share one database but do not use t.Parallel, so this reset cannot race
	// another test's presenting jobs.
	mustExec(t, pool, `delete from presenting_render_jobs`)
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

func TestPresentingClaimSkipsTimeoutDocumentSiblingsIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	timeoutFixture := newPresentingFixture(t, pool, "{publishScreen}")
	goodFixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	clearPresentingRenderJobsForSerialTest(t, pool)
	documentID, timedOutJobID, siblingJobID := newTestID(t), newTestID(t), newTestID(t)
	mustExec(t, pool, `insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status,page_count)
		values($1,$2,$3,$4,$5,$6,1,'deck.pdf','application/pdf',1024,'timeout-source',repeat('c',32)::bytea,'preparing',10)`,
		uuid(timeoutFixture.tenant), uuid(timeoutFixture.space), uuid(timeoutFixture.episode), uuid(documentID), uuid(timeoutFixture.attachment), uuid(timeoutFixture.participant))
	mustExec(t, pool, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,attempt_count,attempt_limit,lease_token,lease_owner,lease_expires_at,available_at)
		values($1,$2,$3,$4,'pages',1,1,'leased',1,1,gen_random_uuid(),'document-renderer',now()-interval '2 minutes',now()-interval '3 minutes')`,
		uuid(timeoutFixture.tenant), uuid(timeoutFixture.space), uuid(documentID), uuid(timedOutJobID))
	mustExec(t, pool, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
		values($1,$2,$3,$4,'pages',2,2,'queued',now()-interval '2 minutes')`,
		uuid(timeoutFixture.tenant), uuid(timeoutFixture.space), uuid(documentID), uuid(siblingJobID))
	good, err := repository.CreateDocument(ctx, goodFixture.subject, goodFixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create good document: %v", err)
	}
	token, _ := utilities.NewID()
	now := time.Now().UTC()
	assignment, err := repository.ClaimRenderJob(ctx, utilities.ID{}, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim with same-pass timeout sibling: %v", err)
	}
	if assignment.Job.JobID != good.InventoryJobID {
		t.Fatalf("claim selected job %s, want good inventory job %s rather than timeout sibling %s", assignment.Job.JobID, good.InventoryJobID, siblingJobID)
	}
	var documentStatus, timedOutCode, siblingStatus, siblingCode string
	if err := pool.QueryRow(ctx, `select document.status, timed_out.error_code, sibling.status, sibling.error_code
		from presenting_documents document
		join presenting_render_jobs timed_out on timed_out.document_id=document.document_id and timed_out.job_id=$2
		join presenting_render_jobs sibling on sibling.document_id=document.document_id and sibling.job_id=$3
		where document.tenant_id=$1 and document.document_id=$4`, uuid(timeoutFixture.tenant), uuid(timedOutJobID), uuid(siblingJobID), uuid(documentID)).Scan(&documentStatus, &timedOutCode, &siblingStatus, &siblingCode); err != nil {
		t.Fatalf("read same-pass timeout rows: %v", err)
	}
	if documentStatus != "failed" || timedOutCode != "timeout" || siblingStatus != "failed" || siblingCode != "document_terminal" {
		t.Fatalf("same-pass timeout left document=%q timed_out=%q sibling=%q/%q", documentStatus, timedOutCode, siblingStatus, siblingCode)
	}
}

func TestPresentingReconcileSkipsExpiredSourceJobsIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	expiredFixture := newPresentingFixture(t, pool, "{publishScreen}")
	goodFixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	clearPresentingRenderJobsForSerialTest(t, pool)
	mustExec(t, pool, `with expired_attachments as (
		insert into sync_chat_attachments(tenant_id,space_id,episode_id,attachment_id,participant_id,participant_generation,client_attachment_id,request_fingerprint,upload_id,object_key,original_filename,mime_type,byte_length,sha256,immutable_object_identity,status,expires_at,finalized_at)
		select $1,$2,$3,gen_random_uuid(),$4,1,'expired-client-'||g,repeat('a',32)::bytea,gen_random_uuid(),'expired-source-'||gen_random_uuid()::text,'deck.pdf','application/pdf',1024,repeat('b',32)::bytea,'object-version','ready',now()-interval '1 minute',now()
		from generate_series(1,50) g
		returning tenant_id,space_id,episode_id,attachment_id,object_key
	), expired_documents as (
		insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status)
		select tenant_id,space_id,episode_id,gen_random_uuid(),attachment_id,$4,1,'deck.pdf','application/pdf',1024,object_key,repeat('b',32)::bytea,'preparing'
		from expired_attachments
		returning tenant_id,space_id,document_id
	)
	insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
	select tenant_id,space_id,document_id,gen_random_uuid(),'inventory',1,1,'queued',now()-interval '1 minute'
	from expired_documents`, uuid(expiredFixture.tenant), uuid(expiredFixture.space), uuid(expiredFixture.episode), uuid(expiredFixture.participant))
	good, err := repository.CreateDocument(ctx, goodFixture.subject, goodFixture.attachment, newTestID(t))
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
		t.Fatalf("reconcile expired-source jobs: %v", err)
	}
	if stale != 1 || invoked != 1 {
		t.Fatalf("expired-source reconcile stale=%d invoked=%d; want one good job only", stale, invoked)
	}
	invokedJobs := invoker.invoked()
	if len(invokedJobs) != 1 || invokedJobs[0] != good.InventoryJobID {
		t.Fatalf("expired-source invoked jobs = %+v, want only good inventory job %s", invokedJobs, good.InventoryJobID)
	}
	var expiredCount int
	if err := pool.QueryRow(ctx, `select count(*) from presenting_render_jobs where tenant_id=$1 and space_id=$2 and status='failed' and error_code='source_expired'`, uuid(expiredFixture.tenant), uuid(expiredFixture.space)).Scan(&expiredCount); err != nil {
		t.Fatalf("count expired-source jobs: %v", err)
	}
	if expiredCount != 50 {
		t.Fatalf("expired-source sweep marked %d jobs; want 50", expiredCount)
	}
}

func TestPresentingSweepAndFailRenderJobDoNotDeadlockIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	clearPresentingRenderJobsForSerialTest(t, pool)
	for iteration := 0; iteration < 20; iteration++ {
		attachmentID := insertAdditionalPresentingAttachment(t, pool, fixture)
		documentID, terminalJobID, targetJobID, leaseToken := newTestID(t), newTestID(t), newTestID(t), newTestID(t)
		mustExec(t, pool, `insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status,failure_code,failure_message,page_count)
			values($1,$2,$3,$4,$5,$6,1,'deck.pdf','application/pdf',1024,'lock-source',repeat('b',32)::bytea,'failed','corrupt','already failed',10)`,
			uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(documentID), uuid(attachmentID), uuid(fixture.participant))
		mustExec(t, pool, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
			values($1,$2,$3,$4,'pages',1,1,'queued',now()-interval '1 minute')`, uuid(fixture.tenant), uuid(fixture.space), uuid(documentID), uuid(terminalJobID))
		mustExec(t, pool, `insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,attempt_count,attempt_limit,lease_token,lease_owner,lease_expires_at,available_at)
			values($1,$2,$3,$4,'pages',2,2,'leased',1,3,$5,'document-renderer',now()+interval '1 minute',now()-interval '1 minute')`, uuid(fixture.tenant), uuid(fixture.space), uuid(documentID), uuid(targetJobID), uuid(leaseToken))
		lease := presenting.RenderLease{TenantID: fixture.tenant, SpaceID: fixture.space, DocumentID: documentID, JobID: targetJobID, Attempt: 1, LeaseToken: leaseToken, LeaseOwner: "document-renderer"}
		start := make(chan struct{})
		errorsCh := make(chan error, 2)
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			token, _ := utilities.NewID()
			now := time.Now().UTC()
			_, err := repository.ClaimRenderJob(ctx, terminalJobID, 1, now, now.Add(time.Minute), token, "document-renderer")
			if errors.Is(err, presenting.ErrNoRenderJob) {
				err = nil
			}
			errorsCh <- err
		}()
		go func() {
			defer workers.Done()
			<-start
			err := repository.FailRenderJob(ctx, lease, presenting.RenderFailure{Code: "corrupt", Message: "corrupt in concurrency test"})
			if errors.Is(err, presenting.ErrLeaseLost) {
				err = nil
			}
			errorsCh <- err
		}()
		close(start)
		workers.Wait()
		close(errorsCh)
		for err := range errorsCh {
			if err != nil {
				t.Fatalf("concurrent sweep/fail iteration %d: %v", iteration, err)
			}
		}
	}
}

func TestPresentingReconcileSkipsTerminalDocumentJobsIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	clearPresentingRenderJobsForSerialTest(t, pool)
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
		insert into presenting_documents(tenant_id,space_id,episode_id,document_id,attachment_id,created_by_participant_id,created_by_participant_generation,file_name,mime_type,byte_length,source_object_key,source_sha256,status,page_count)
		values($1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,1,'timeout-deck.pdf','application/pdf',1024,'timeout-source',repeat('c',32)::bytea,'preparing',10)
		returning tenant_id,space_id,document_id
	), expired_pages as (
		insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,attempt_count,attempt_limit,lease_token,lease_owner,lease_expires_at,available_at)
		select tenant_id,space_id,document_id,gen_random_uuid(),'pages',1,1,'leased',1,1,gen_random_uuid(),'document-renderer',now()-interval '2 minutes',now()-interval '3 minutes'
		from timeout_document
		returning job_id
	)
	insert into presenting_render_jobs(tenant_id,space_id,document_id,job_id,kind,page_start,page_end,status,available_at)
	select tenant_id,space_id,document_id,gen_random_uuid(),'pages',g,g,'queued',now()-interval '1 minute'
	from timeout_document, generate_series(2,11) g`, uuid(fixture.tenant), uuid(fixture.space), uuid(fixture.episode), uuid(fixture.participant))
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
	if terminalCount != 70 {
		t.Fatalf("terminal sweep marked %d jobs; want 60 terminal-document jobs plus 10 timeout siblings", terminalCount)
	}
	var activeSiblingCount int
	if err := pool.QueryRow(ctx, `select count(*) from presenting_render_jobs job
		join presenting_documents document on document.tenant_id=job.tenant_id and document.space_id=job.space_id and document.document_id=job.document_id
		where job.tenant_id=$1 and job.space_id=$2 and document.failure_code='timeout' and job.kind='pages' and job.status='queued'`, uuid(fixture.tenant), uuid(fixture.space)).Scan(&activeSiblingCount); err != nil {
		t.Fatalf("count active sibling jobs: %v", err)
	}
	if activeSiblingCount != 0 {
		t.Fatalf("active sibling jobs after terminalization = %d; want the 10 seeded siblings swept terminal", activeSiblingCount)
	}
}
