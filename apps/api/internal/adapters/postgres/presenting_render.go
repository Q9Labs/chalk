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

func (r PresentingRepository) ClaimRenderJob(ctx context.Context, jobID utilities.ID, expectedAttempt int, now, leaseUntil time.Time, token utilities.ID, owner string) (presenting.RenderAssignment, error) {
	optionalJob := pgtype.UUID{Valid: !jobID.IsZero()}
	if optionalJob.Valid {
		optionalJob.Bytes = jobID.Bytes()
	}
	job, err := r.queries.ClaimPresentingRenderJob(ctx, sqlc.ClaimPresentingRenderJobParams{
		LeaseToken: uuid(token), LeaseOwner: pgtype.Text{String: owner, Valid: true}, LeaseExpiresAt: pgtype.Timestamptz{Time: leaseUntil, Valid: true},
		ExpectedAttempt: int32(expectedAttempt), NowAt: pgtype.Timestamptz{Time: now, Valid: true}, JobID: optionalJob,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return presenting.RenderAssignment{}, presenting.ErrNoRenderJob
	}
	if err != nil {
		return presenting.RenderAssignment{}, fmt.Errorf("claim presenting render job: %w", err)
	}
	row, err := r.queries.GetPresentingRenderJobDocument(ctx, sqlc.GetPresentingRenderJobDocumentParams{TenantID: job.TenantID, SpaceID: job.SpaceID, DocumentID: job.DocumentID})
	if err != nil {
		return presenting.RenderAssignment{}, fmt.Errorf("read presenting render document: %w", err)
	}
	document, err := presentingDocument(row.TenantID, row.SpaceID, row.EpisodeID, row.DocumentID, row.AttachmentID, row.FileName, row.MimeType, row.ByteLength, row.SourceObjectKey, row.SourceSha256, row.Status, row.FailureCode, row.FailureMessage, row.PageCount, false)
	if err != nil {
		return presenting.RenderAssignment{}, err
	}
	return presenting.RenderAssignment{Job: presentingJob(job), Document: document}, nil
}

func (r PresentingRepository) HeartbeatRenderJob(ctx context.Context, lease presenting.RenderLease, leaseUntil time.Time) error {
	rows, err := r.queries.HeartbeatPresentingRenderJob(ctx, sqlc.HeartbeatPresentingRenderJobParams{
		LeaseExpiresAt: pgtype.Timestamptz{Time: leaseUntil, Valid: true}, TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(lease.JobID),
		AttemptCount: int32(lease.Attempt), LeaseOwner: pgtype.Text{String: lease.LeaseOwner, Valid: true}, LeaseToken: uuid(lease.LeaseToken), NowAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if err != nil {
		return fmt.Errorf("heartbeat presenting render job: %w", err)
	}
	if rows != 1 {
		return presenting.ErrLeaseLost
	}
	return nil
}

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
	if err := storeInventory(ctx, q, report); err != nil {
		return nil, err
	}
	if err := publishPresentingPage(ctx, q, lease, 1); err != nil {
		return nil, err
	}
	if report.PageCount == 1 {
		if _, err := q.CompletePresentingDocumentIfReady(ctx, sqlc.CompletePresentingDocumentIfReadyParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), ReadyPages: pgtype.Int4{Int32: 1, Valid: true}}); err != nil {
			return nil, fmt.Errorf("complete one-page presenting document: %w", err)
		}
	}
	jobs, err := createPageJobs(ctx, q, lease, report.PageCount, rangeSize)
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

// storeInventory records the document's page count and each page's size. The lease must still own the document.
func storeInventory(ctx context.Context, q *sqlc.Queries, report presenting.InventoryReport) error {
	lease := report.Lease
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
	return nil
}

// createPageJobs queues one page-range job for every range after page one, which the completion publishes itself.
func createPageJobs(ctx context.Context, q *sqlc.Queries, lease presenting.RenderLease, pageCount, rangeSize int) ([]presenting.RenderJob, error) {
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

func (r PresentingRepository) CompleteRenderJob(ctx context.Context, lease presenting.RenderLease) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin presenting render completion: %w", err)
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	if err := completePresentingJob(ctx, q, lease); err != nil {
		return err
	}
	ready, err := q.CountPresentingReadyPages(ctx, sqlc.CountPresentingReadyPagesParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID)})
	if err != nil {
		return fmt.Errorf("count presenting ready pages: %w", err)
	}
	_, err = q.CompletePresentingDocumentIfReady(ctx, sqlc.CompletePresentingDocumentIfReadyParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), ReadyPages: pgtype.Int4{Int32: ready, Valid: true}})
	if err != nil {
		return fmt.Errorf("complete presenting document: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit presenting render completion: %w", err)
	}
	return nil
}

func (r PresentingRepository) FailRenderJob(ctx context.Context, lease presenting.RenderLease, failure presenting.RenderFailure) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin presenting render failure: %w", err)
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	rows, err := q.FailPresentingRenderJob(ctx, sqlc.FailPresentingRenderJobParams{
		ErrorCode: pgtype.Text{String: failure.Code, Valid: true}, ErrorMessage: pgtype.Text{String: failure.Message, Valid: true},
		TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(lease.JobID), AttemptCount: int32(lease.Attempt), LeaseOwner: pgtype.Text{String: lease.LeaseOwner, Valid: true}, LeaseToken: uuid(lease.LeaseToken), NowAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if err != nil {
		return fmt.Errorf("fail presenting render job: %w", err)
	}
	if rows != 1 {
		return presenting.ErrLeaseLost
	}
	_, err = q.FailPresentingDocument(ctx, sqlc.FailPresentingDocumentParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(lease.JobID), FailureCode: pgtype.Text{String: failure.Code, Valid: true}, FailureMessage: pgtype.Text{String: failure.Message, Valid: true}})
	if err != nil {
		return fmt.Errorf("fail presenting document: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit presenting render failure: %w", err)
	}
	return nil
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

func completePresentingJob(ctx context.Context, q *sqlc.Queries, lease presenting.RenderLease) error {
	rows, err := q.CompletePresentingRenderJob(ctx, sqlc.CompletePresentingRenderJobParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(lease.JobID), AttemptCount: int32(lease.Attempt), LeaseOwner: pgtype.Text{String: lease.LeaseOwner, Valid: true}, LeaseToken: uuid(lease.LeaseToken), NowAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}})
	if err != nil {
		return fmt.Errorf("complete presenting render job: %w", err)
	}
	if rows != 1 {
		return presenting.ErrLeaseLost
	}
	return nil
}
