package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r PresentingRepository) CompleteZoom(ctx context.Context, lease presenting.RenderLease) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin presenting zoom completion: %w", err)
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	zoomKey, err := presentingRenderUploadKey(ctx, q, lease, lease.Page, "zoom")
	if err != nil {
		return err
	}
	rows, err := q.MarkPresentingZoomReady(ctx, sqlc.MarkPresentingZoomReadyParams{
		TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), Page: int32(lease.Page), ZoomReadyAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}, ZoomKey: pgtype.Text{String: zoomKey, Valid: true},
		JobID: uuid(lease.JobID), AttemptCount: int32(lease.Attempt), LeaseOwner: pgtype.Text{String: lease.LeaseOwner, Valid: true}, LeaseToken: uuid(lease.LeaseToken), NowAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if err != nil {
		return fmt.Errorf("mark presenting zoom ready: %w", err)
	}
	if rows != 1 {
		return presenting.ErrLeaseLost
	}
	if err := completePresentingJob(ctx, q, lease); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r PresentingRepository) EnsureZoomJob(ctx context.Context, document presenting.Document, page int, now time.Time) (presenting.RenderJob, bool, error) {
	jobID, err := utilities.NewID()
	if err != nil {
		return presenting.RenderJob{}, false, fmt.Errorf("generate presenting zoom job id: %w", err)
	}
	job := presenting.RenderJob{Kind: "zoom", PageStart: page, PageEnd: page, RenderLease: presenting.RenderLease{TenantID: document.TenantID, SpaceID: document.SpaceID, DocumentID: document.DocumentID, JobID: jobID}}
	row, err := r.queries.CreatePresentingRenderJob(ctx, sqlc.CreatePresentingRenderJobParams{TenantID: uuid(document.TenantID), SpaceID: uuid(document.SpaceID), DocumentID: uuid(document.DocumentID), JobID: uuid(jobID), Kind: "zoom", PageStart: int32(page), PageEnd: int32(page), AttemptLimit: presenting.RenderAttemptLimit, AvailableAt: pgtype.Timestamptz{Time: now, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return presenting.RenderJob{}, false, nil
	}
	if err != nil {
		return presenting.RenderJob{}, false, fmt.Errorf("create presenting zoom job: %w", err)
	}
	job.JobID = utilities.IDFromBytes(row.JobID.Bytes)
	return job, true, nil
}
