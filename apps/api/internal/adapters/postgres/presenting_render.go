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

func (r PresentingRepository) CreateRenderJob(ctx context.Context, job presenting.RenderJob) error {
	id, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("generate presenting render job id: %w", err)
	}
	if job.JobID.IsZero() {
		job.JobID = id
	}
	row, err := r.queries.CreatePresentingRenderJob(ctx, sqlc.CreatePresentingRenderJobParams{
		TenantID: uuid(job.TenantID), SpaceID: uuid(job.SpaceID), DocumentID: uuid(job.DocumentID), JobID: uuid(job.JobID),
		Kind: job.Kind, PageStart: int32(job.PageStart), PageEnd: int32(job.PageEnd), AttemptLimit: presenting.RenderAttemptLimit,
		AvailableAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	})
	if err != nil || row.JobID.Valid {
		return err
	}
	return nil
}

func (r PresentingRepository) TrackRenderUploads(ctx context.Context, uploads []presenting.RenderUpload) error {
	for _, upload := range uploads {
		if upload.Page < 1 || upload.Page > presenting.MaxPages || upload.Attempt < 1 || upload.Attempt > presenting.RenderAttemptLimit || len(upload.ObjectKey) == 0 || len(upload.ObjectKey) > 1024 {
			return presenting.ErrInvalidInput
		}
		if upload.Rendition != "image" && upload.Rendition != "thumbnail" && upload.Rendition != "zoom" {
			return presenting.ErrInvalidInput
		}
		if _, err := r.queries.InsertPresentingRenderUpload(ctx, sqlc.InsertPresentingRenderUploadParams{
			TenantID: uuid(upload.TenantID), SpaceID: uuid(upload.SpaceID), DocumentID: uuid(upload.DocumentID), JobID: uuid(upload.JobID),
			Page: int32(upload.Page), Rendition: upload.Rendition, Attempt: int32(upload.Attempt), ObjectKey: upload.ObjectKey,
		}); err != nil {
			return fmt.Errorf("track presenting render upload: %w", err)
		}
	}
	return nil
}

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

func (r PresentingRepository) CompleteRenderJob(ctx context.Context, lease presenting.RenderLease) error {
	if err := completePresentingJob(ctx, r.queries, lease); err != nil {
		return err
	}
	ready, err := r.queries.CountPresentingReadyPages(ctx, sqlc.CountPresentingReadyPagesParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID)})
	if err != nil {
		return fmt.Errorf("count presenting ready pages: %w", err)
	}
	_, err = r.queries.CompletePresentingDocumentIfReady(ctx, sqlc.CompletePresentingDocumentIfReadyParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), ReadyPages: pgtype.Int4{Int32: ready, Valid: true}})
	if err != nil {
		return fmt.Errorf("complete presenting document: %w", err)
	}
	return nil
}

func (r PresentingRepository) FailRenderJob(ctx context.Context, lease presenting.RenderLease, failure presenting.RenderFailure) error {
	rows, err := r.queries.FailPresentingRenderJob(ctx, sqlc.FailPresentingRenderJobParams{
		ErrorCode: pgtype.Text{String: failure.Code, Valid: true}, ErrorMessage: pgtype.Text{String: failure.Message, Valid: true},
		TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(lease.JobID), AttemptCount: int32(lease.Attempt), LeaseOwner: pgtype.Text{String: lease.LeaseOwner, Valid: true}, LeaseToken: uuid(lease.LeaseToken),
	})
	if err != nil {
		return fmt.Errorf("fail presenting render job: %w", err)
	}
	if rows != 1 {
		return presenting.ErrLeaseLost
	}
	_, err = r.queries.FailPresentingDocument(ctx, sqlc.FailPresentingDocumentParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), FailureCode: pgtype.Text{String: failure.Code, Valid: true}, FailureMessage: pgtype.Text{String: failure.Message, Valid: true}})
	if err != nil {
		return fmt.Errorf("fail presenting document: %w", err)
	}
	return nil
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

func (r PresentingRepository) ListStaleRenderJobs(ctx context.Context, now time.Time, limit int) ([]presenting.RenderJob, error) {
	rows, err := r.queries.ListStalePresentingRenderJobs(ctx, sqlc.ListStalePresentingRenderJobsParams{NowAt: pgtype.Timestamptz{Time: now.UTC(), Valid: true}, BatchLimit: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("list stale presenting render jobs: %w", err)
	}
	jobs := make([]presenting.RenderJob, 0, len(rows))
	for _, row := range rows {
		lease := presenting.RenderLease{TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), DocumentID: utilities.IDFromBytes(row.DocumentID.Bytes), JobID: utilities.IDFromBytes(row.JobID.Bytes), Attempt: int(row.AttemptCount)}
		if row.LeaseToken.Valid {
			lease.LeaseToken = utilities.IDFromBytes(row.LeaseToken.Bytes)
		}
		if row.LeaseOwner.Valid {
			lease.LeaseOwner = row.LeaseOwner.String
		}
		if row.LeaseExpiresAt.Valid {
			lease.LeaseExpiry = row.LeaseExpiresAt.Time
		}
		jobs = append(jobs, presenting.RenderJob{RenderLease: lease, Kind: row.Kind, PageStart: int(row.PageStart), PageEnd: int(row.PageEnd)})
	}
	return jobs, nil
}

func completePresentingJob(ctx context.Context, q *sqlc.Queries, lease presenting.RenderLease) error {
	rows, err := q.CompletePresentingRenderJob(ctx, sqlc.CompletePresentingRenderJobParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(lease.JobID), AttemptCount: int32(lease.Attempt), LeaseOwner: pgtype.Text{String: lease.LeaseOwner, Valid: true}, LeaseToken: uuid(lease.LeaseToken)})
	if err != nil {
		return fmt.Errorf("complete presenting render job: %w", err)
	}
	if rows != 1 {
		return presenting.ErrLeaseLost
	}
	return nil
}

func presentingJob(row sqlc.PresentingRenderJob) presenting.RenderJob {
	lease := presenting.RenderLease{
		TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), DocumentID: utilities.IDFromBytes(row.DocumentID.Bytes), JobID: utilities.IDFromBytes(row.JobID.Bytes),
		Attempt: int(row.AttemptCount),
	}
	if row.LeaseToken.Valid {
		lease.LeaseToken = utilities.IDFromBytes(row.LeaseToken.Bytes)
	}
	if row.LeaseOwner.Valid {
		lease.LeaseOwner = row.LeaseOwner.String
	}
	if row.LeaseExpiresAt.Valid {
		lease.LeaseExpiry = row.LeaseExpiresAt.Time
	}
	return presenting.RenderJob{RenderLease: lease, Kind: row.Kind, PageStart: int(row.PageStart), PageEnd: int(row.PageEnd)}
}
