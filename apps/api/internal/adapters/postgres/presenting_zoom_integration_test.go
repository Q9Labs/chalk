package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPresentingZoomFailureLeavesReadyDocumentIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	mustExec(t, pool, `update presenting_documents set status='ready', page_count=1 where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	mustExec(t, pool, `insert into presenting_document_pages(tenant_id,space_id,document_id,page,width,height,status,image_key,thumbnail_key)
		values($1,$2,$3,1,1600,900,'ready','test-image','test-thumbnail')`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID))
	now := time.Now().UTC()
	job, created, err := repository.EnsureZoomJob(ctx, document, 1, now)
	if err != nil || !created {
		t.Fatalf("create zoom job created=%v err=%v", created, err)
	}
	token, _ := utilities.NewID()
	claimed, err := repository.ClaimRenderJob(ctx, job.JobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim zoom job: %v", err)
	}
	lease := claimed.Job.RenderLease
	if err := repository.FailRenderJob(ctx, lease, presenting.RenderFailure{Code: "corrupt", Message: "zoom render failed"}); err != nil {
		t.Fatalf("fail zoom job: %v", err)
	}
	var jobStatus, documentStatus string
	if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&jobStatus); err != nil {
		t.Fatalf("read zoom job status: %v", err)
	}
	if err := pool.QueryRow(ctx, `select status from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID)).Scan(&documentStatus); err != nil {
		t.Fatalf("read document status: %v", err)
	}
	if jobStatus != "failed" || documentStatus != "ready" {
		t.Fatalf("zoom failure left job=%q document=%q", jobStatus, documentStatus)
	}
}

func TestPresentingFinalRenderAttemptTimeoutFailsDocumentIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	realNow := time.Now().UTC()
	claimNow := realNow.Add(2 * time.Second)
	leaseUntil := realNow.Add(-time.Minute)
	var lease presenting.RenderLease
	for attempt := 1; attempt <= presenting.RenderAttemptLimit; attempt++ {
		token, _ := utilities.NewID()
		claimed, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, attempt, claimNow, leaseUntil, token, "document-renderer")
		if err != nil {
			t.Fatalf("claim attempt %d: %v", attempt, err)
		}
		lease = claimed.Job.RenderLease
		claimNow = claimNow.Add(time.Second)
	}
	jobs, err := repository.ListStaleRenderJobs(ctx, claimNow, 10)
	if err != nil {
		t.Fatalf("list stale jobs: %v", err)
	}
	for _, job := range jobs {
		if job.DocumentID == document.DocumentID {
			t.Fatalf("final expired attempt was offered for another retry: %+v", job)
		}
	}
	var jobStatus, documentStatus string
	if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&jobStatus); err != nil {
		t.Fatalf("read job status: %v", err)
	}
	if err := pool.QueryRow(ctx, `select status from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID)).Scan(&documentStatus); err != nil {
		t.Fatalf("read document status: %v", err)
	}
	if jobStatus != "failed" || documentStatus != "failed" {
		t.Fatalf("final timeout left job=%q document=%q", jobStatus, documentStatus)
	}
}

func TestPresentingFinalTimeoutLeavesReadyDocumentIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	if _, err := pool.Exec(ctx, `update presenting_documents set status = 'ready' where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(document.TenantID), uuid(document.SpaceID), uuid(document.DocumentID)); err != nil {
		t.Fatalf("mark document ready: %v", err)
	}
	realNow := time.Now().UTC()
	claimNow := realNow.Add(2 * time.Second)
	leaseUntil := realNow.Add(-time.Minute)
	var lease presenting.RenderLease
	for attempt := 1; attempt <= presenting.RenderAttemptLimit; attempt++ {
		token, _ := utilities.NewID()
		claimed, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, attempt, claimNow, leaseUntil, token, "document-renderer")
		if err != nil {
			t.Fatalf("claim attempt %d: %v", attempt, err)
		}
		lease = claimed.Job.RenderLease
		claimNow = claimNow.Add(time.Second)
	}
	token, _ := utilities.NewID()
	_, err = repository.ClaimRenderJob(ctx, document.InventoryJobID, presenting.RenderAttemptLimit+1, claimNow, leaseUntil, token, "document-renderer")
	if !errors.Is(err, presenting.ErrNoRenderJob) {
		t.Fatalf("final-attempt claim error = %v", err)
	}
	var jobStatus, documentStatus string
	if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&jobStatus); err != nil {
		t.Fatalf("read job status: %v", err)
	}
	if err := pool.QueryRow(ctx, `select status from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID)).Scan(&documentStatus); err != nil {
		t.Fatalf("read document status: %v", err)
	}
	if jobStatus != "failed" || documentStatus != "ready" {
		t.Fatalf("ready-document timeout left job=%q document=%q", jobStatus, documentStatus)
	}
}
