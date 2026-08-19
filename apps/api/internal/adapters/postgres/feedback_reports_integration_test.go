package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/feedback"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestFeedbackRepositoryPersistsIdempotencyAndTenantScope(t *testing.T) {
	databaseURL := os.Getenv("CHALK_FEEDBACK_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("CHALK_FEEDBACK_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect feedback database: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := newFeedbackRepositoryID(t)
	otherTenantID := newFeedbackRepositoryID(t)
	if _, err := pool.Exec(ctx, `insert into tenants (id, name) values ($1, 'Feedback repository integration'), ($2, 'Feedback other Tenant')`, tenantID.Bytes(), otherTenantID.Bytes()); err != nil {
		t.Fatalf("seed feedback Tenants: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from feedback_reports where tenant_id in ($1, $2)`, tenantID.Bytes(), otherTenantID.Bytes())
		_, _ = pool.Exec(cleanupCtx, `delete from tenants where id in ($1, $2)`, tenantID.Bytes(), otherTenantID.Bytes())
	})

	repository := NewFeedbackRepository(sqlc.New(pool))
	reportID := newFeedbackRepositoryID(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	evidence := []byte(`{"schema_version":"FeedbackEvidence/v1"}`)
	report := feedback.Report{
		ID: reportID, TenantID: tenantID, Category: feedback.CategoryBug, Source: feedback.SourceDashboard,
		Message: "The toolbar stopped responding.", SubmitterKind: feedback.SubmitterAccount, SubmitterID: "account-submitter",
		IdempotencyKey: "feedback-integration-key", RequestDigest: sha256.Sum256([]byte("request")),
		EvidenceObjectKey: "feedback/tenant/report/evidence-v1.json", EvidenceSize: int64(len(evidence)), EvidenceSHA256: sha256.Sum256(evidence), EvidenceSchemaVersion: feedback.EvidenceSchemaVersion,
		CreatedAt: now, SubmittedAt: now,
	}
	created, err := repository.Create(ctx, feedback.CreateInput{Report: report})
	if err != nil {
		t.Fatalf("create feedback report: %v", err)
	}
	if created.ID != reportID || created.TenantID != tenantID || created.Message != report.Message {
		t.Fatalf("created feedback report = %#v", created)
	}

	replayed, err := repository.GetByIdempotency(ctx, feedback.IdempotencyLookup{TenantID: tenantID, SubmitterKind: feedback.SubmitterAccount, SubmitterID: report.SubmitterID, Key: report.IdempotencyKey})
	if err != nil || replayed.ID != reportID {
		t.Fatalf("idempotency lookup = %#v, %v", replayed, err)
	}
	if _, err := repository.GetForTenant(ctx, otherTenantID, reportID); !errors.Is(err, feedback.ErrReportNotFound) {
		t.Fatalf("cross-Tenant lookup error = %v, want not found", err)
	}
	listed, err := repository.List(ctx, feedback.ListInput{TenantID: &tenantID, Limit: 25})
	if err != nil || len(listed.Reports) != 1 || listed.Reports[0].ID != reportID {
		t.Fatalf("Tenant list = %#v, %v", listed, err)
	}
}

func newFeedbackRepositoryID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatalf("create feedback repository id: %v", err)
	}
	return id
}
