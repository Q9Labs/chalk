package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPresentingInfrastructureFailureRequeuesRenderJobIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	now := time.Now().UTC()
	token, _ := utilities.NewID()
	claimed, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim inventory job: %v", err)
	}
	lease := claimed.Job.RenderLease
	if err := repository.FailRenderJob(ctx, lease, presenting.RenderFailure{Code: "infrastructure", Message: "sandbox unavailable"}); err != nil {
		t.Fatalf("report infrastructure failure: %v", err)
	}
	var jobStatus, documentStatus, code string
	if err := pool.QueryRow(ctx, `select status, error_code from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&jobStatus, &code); err != nil {
		t.Fatalf("read requeued job: %v", err)
	}
	if err := pool.QueryRow(ctx, `select status from presenting_documents where tenant_id=$1 and space_id=$2 and document_id=$3`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID)).Scan(&documentStatus); err != nil {
		t.Fatalf("read document: %v", err)
	}
	if jobStatus != "queued" || documentStatus != "preparing" || code != "infrastructure" {
		t.Fatalf("infrastructure failure left job=%q document=%q code=%q", jobStatus, documentStatus, code)
	}
	retryToken, _ := utilities.NewID()
	if _, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, 2, time.Now().UTC(), time.Now().UTC().Add(time.Minute), retryToken, "document-renderer"); err != nil {
		t.Fatalf("claim infrastructure retry: %v", err)
	}
}

func TestPresentingFailureCannotOverwriteSweptTimeoutIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	fixture := newPresentingFixture(t, pool, "{publishScreen}")
	ctx := context.Background()
	document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	now := time.Now().UTC()
	token, _ := utilities.NewID()
	claimed, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, 1, now, now.Add(time.Minute), token, "document-renderer")
	if err != nil {
		t.Fatalf("claim inventory job: %v", err)
	}
	lease := claimed.Job.RenderLease
	mustExec(t, pool, `update presenting_render_jobs set status='failed', error_code='timeout', error_message='Render worker lease expired at the attempt limit', completed_at=now(), updated_at=now() where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID))
	err = repository.FailRenderJob(ctx, lease, presenting.RenderFailure{Code: "corrupt", Message: "late parser report"})
	if !errors.Is(err, presenting.ErrLeaseLost) {
		t.Fatalf("late failure error = %v", err)
	}
	var code string
	if err := pool.QueryRow(ctx, `select error_code from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&code); err != nil {
		t.Fatalf("read job error code: %v", err)
	}
	if code != "timeout" {
		t.Fatalf("late failure overwrote timeout with %q", code)
	}
}

func TestPresentingExpiredLeaseCannotCompleteOrFailRenderJobIntegration(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	repository := NewPresentingRepository(pool)
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		fail bool
	}{
		{name: "complete"},
		{name: "fail", fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newPresentingFixture(t, pool, "{publishScreen}")
			document, err := repository.CreateDocument(ctx, fixture.subject, fixture.attachment, newTestID(t))
			if err != nil {
				t.Fatalf("create document: %v", err)
			}
			now := time.Now().UTC()
			token, _ := utilities.NewID()
			claimed, err := repository.ClaimRenderJob(ctx, document.InventoryJobID, 1, now, now.Add(-time.Second), token, "document-renderer")
			if err != nil {
				t.Fatalf("claim inventory job: %v", err)
			}
			lease := claimed.Job.RenderLease
			if tc.fail {
				err = repository.FailRenderJob(ctx, lease, presenting.RenderFailure{Code: "corrupt", Message: "corrupt source"})
			} else {
				err = repository.CompleteRenderJob(ctx, lease)
			}
			if !errors.Is(err, presenting.ErrLeaseLost) {
				t.Fatalf("expired lease callback error = %v", err)
			}
			var status string
			if err := pool.QueryRow(ctx, `select status from presenting_render_jobs where tenant_id=$1 and space_id=$2 and document_id=$3 and job_id=$4`, uuid(lease.TenantID), uuid(lease.SpaceID), uuid(lease.DocumentID), uuid(lease.JobID)).Scan(&status); err != nil {
				t.Fatalf("read job status: %v", err)
			}
			if status != "leased" {
				t.Fatalf("expired lease changed job status to %q", status)
			}
		})
	}
}
