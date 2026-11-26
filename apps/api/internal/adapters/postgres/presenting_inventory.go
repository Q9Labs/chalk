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

func (r PresentingRepository) CompleteInventory(ctx context.Context, report presenting.InventoryReport, rangeSize int) ([]presenting.RenderJob, error) {
	if report.PageCount < 1 || report.PageCount > presenting.MaxPages || len(report.Pages) != report.PageCount || rangeSize < 1 {
		return nil, presenting.ErrInvalidInput
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin presenting inventory completion: %w", err)
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	lease := report.Lease
	if err := storePresentingInventory(ctx, q, lease, report); err != nil {
		return nil, err
	}
	jobs, err := createPresentingPageJobs(ctx, q, lease, report.PageCount, rangeSize)
	if err != nil {
		return nil, err
	}
	if err := completePresentingJob(ctx, q, lease); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit presenting inventory completion: %w", err)
	}
	return jobs, nil
}

func storePresentingInventory(ctx context.Context, q *sqlc.Queries, lease presenting.RenderLease, report presenting.InventoryReport) error {
	if rows, err := q.SetPresentingDocumentInventory(ctx, sqlc.SetPresentingDocumentInventoryParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), PageCount: pgtype.Int4{Int32: int32(report.PageCount), Valid: true}}); err != nil || rows != 1 {
		if err == nil {
			err = presenting.ErrLeaseLost
		}
		return fmt.Errorf("store presenting inventory: %w", err)
	}
	for _, page := range report.Pages {
		if page.Page < 1 || page.Page > report.PageCount || page.Width < 1 || page.Height < 1 {
			return presenting.ErrInvalidInput
		}
		if err := q.InsertPresentingDocumentPage(ctx, sqlc.InsertPresentingDocumentPageParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), Page: int32(page.Page), Width: int32(page.Width), Height: int32(page.Height)}); err != nil {
			return fmt.Errorf("store presenting page inventory: %w", err)
		}
	}
	if err := publishPresentingPage(ctx, q, lease, 1); err != nil {
		return err
	}
	if report.PageCount == 1 {
		if _, err := q.CompletePresentingDocumentIfReady(ctx, sqlc.CompletePresentingDocumentIfReadyParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), ReadyPages: pgtype.Int4{Int32: 1, Valid: true}}); err != nil {
			return fmt.Errorf("complete one-page presenting document: %w", err)
		}
	}
	return nil
}

func createPresentingPageJobs(ctx context.Context, q *sqlc.Queries, lease presenting.RenderLease, pageCount, rangeSize int) ([]presenting.RenderJob, error) {
	jobs := []presenting.RenderJob{}
	for start := 2; start <= pageCount; start += rangeSize {
		end := min(start+rangeSize-1, pageCount)
		jobID, err := utilities.NewID()
		if err != nil {
			return nil, fmt.Errorf("generate presenting page job id: %w", err)
		}
		job := presenting.RenderJob{Kind: "pages", PageStart: start, PageEnd: end, RenderLease: presenting.RenderLease{TenantID: lease.TenantID, SpaceID: lease.SpaceID, DocumentID: lease.DocumentID, JobID: jobID}}
		if _, err := q.CreatePresentingRenderJob(ctx, sqlc.CreatePresentingRenderJobParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(jobID), Kind: "pages", PageStart: int32(start), PageEnd: int32(end), AttemptLimit: presenting.RenderAttemptLimit, AvailableAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}}); err != nil {
			return nil, fmt.Errorf("create presenting page job: %w", err)
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

func (r PresentingRepository) MarkPageReady(ctx context.Context, lease presenting.RenderLease, page int) error {
	if page < 1 || page > presenting.MaxPages {
		return presenting.ErrInvalidInput
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin presenting page publication: %w", err)
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	if err := publishPresentingPage(ctx, q, lease, page); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

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

func publishPresentingPage(ctx context.Context, q *sqlc.Queries, lease presenting.RenderLease, page int) error {
	imageKey, err := presentingRenderUploadKey(ctx, q, lease, page, "image")
	if err != nil {
		return err
	}
	thumbnailKey, err := presentingRenderUploadKey(ctx, q, lease, page, "thumbnail")
	if err != nil {
		return err
	}
	rows, err := q.MarkPresentingPageReady(ctx, sqlc.MarkPresentingPageReadyParams{
		TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), Page: int32(page),
		ImageKey: pgtype.Text{String: imageKey, Valid: true}, ThumbnailKey: pgtype.Text{String: thumbnailKey, Valid: true},
		JobID: uuid(lease.JobID), AttemptCount: int32(lease.Attempt), LeaseOwner: pgtype.Text{String: lease.LeaseOwner, Valid: true}, LeaseToken: uuid(lease.LeaseToken), NowAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if err != nil {
		return fmt.Errorf("mark presenting page ready: %w", err)
	}
	if rows != 1 {
		return presenting.ErrLeaseLost
	}
	return nil
}

func presentingRenderUploadKey(ctx context.Context, q *sqlc.Queries, lease presenting.RenderLease, page int, rendition string) (string, error) {
	key, err := q.GetPresentingRenderUpload(ctx, sqlc.GetPresentingRenderUploadParams{
		TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(lease.JobID),
		Page: int32(page), Rendition: rendition, Attempt: int32(lease.Attempt),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", presenting.ErrLeaseLost
	}
	if err != nil {
		return "", fmt.Errorf("read tracked presenting upload: %w", err)
	}
	return key, nil
}
