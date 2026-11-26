package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
	"github.com/q9labs/chalk/apps/api/internal/presenting"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type PresentingRepository struct {
	queries *sqlc.Queries
	db      presentingDB
}

type presentingDB interface {
	sqlc.DBTX
	Begin(context.Context) (pgx.Tx, error)
}

func NewPresentingRepository(db presentingDB) PresentingRepository {
	return PresentingRepository{queries: sqlc.New(db), db: db}
}

func (r PresentingRepository) CreateDocument(ctx context.Context, subject presenting.Subject, attachmentID, documentID utilities.ID) (presenting.Document, error) {
	mimeType, err := r.queries.GetPresentingAttachmentMIMEType(ctx, sqlc.GetPresentingAttachmentMIMETypeParams{
		TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID), EpisodeID: uuid(subject.EpisodeID),
		ParticipantID: uuid(subject.ParticipantID), ParticipantGeneration: subject.ParticipantGeneration, AttachmentID: uuid(attachmentID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return presenting.Document{}, presenting.ErrPermissionDenied
	}
	if err != nil {
		return presenting.Document{}, fmt.Errorf("read presenting source attachment: %w", err)
	}
	switch mimeType {
	case "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp":
	default:
		return presenting.Document{}, presenting.ErrUnsupportedType
	}
	inventoryJobID, err := utilities.NewID()
	if err != nil {
		return presenting.Document{}, fmt.Errorf("generate presenting inventory job id: %w", err)
	}
	row, err := r.queries.CreatePresentingDocument(ctx, sqlc.CreatePresentingDocumentParams{
		TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID), EpisodeID: uuid(subject.EpisodeID),
		ParticipantID: uuid(subject.ParticipantID), ParticipantGeneration: subject.ParticipantGeneration,
		AttachmentID: uuid(attachmentID), DocumentID: uuid(documentID), InventoryJobID: uuid(inventoryJobID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return presenting.Document{}, presenting.ErrPermissionDenied
	}
	if err != nil {
		return presenting.Document{}, fmt.Errorf("create presenting document: %w", err)
	}
	document, err := presentingDocument(row.TenantID, row.SpaceID, row.EpisodeID, row.DocumentID, row.AttachmentID, row.FileName, row.MimeType, row.ByteLength, row.SourceObjectKey, row.SourceSha256, row.Status, row.FailureCode, row.FailureMessage, row.PageCount, row.Created)
	if err != nil {
		return presenting.Document{}, err
	}
	if row.InventoryJobID.Valid {
		document.InventoryJobID = utilities.IDFromBytes(row.InventoryJobID.Bytes)
	}
	return document, nil
}

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

func (r PresentingRepository) AuthorizedDocument(ctx context.Context, subject presenting.Subject, documentID utilities.ID) (presenting.Document, error) {
	row, err := r.queries.GetAuthorizedPresentingDocument(ctx, sqlc.GetAuthorizedPresentingDocumentParams{
		TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID), EpisodeID: uuid(subject.EpisodeID), DocumentID: uuid(documentID),
		ParticipantID: uuid(subject.ParticipantID), ParticipantGeneration: subject.ParticipantGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return presenting.Document{}, presenting.ErrDocumentNotFound
	}
	if err != nil {
		return presenting.Document{}, fmt.Errorf("read presenting document: %w", err)
	}
	return presentingDocument(row.TenantID, row.SpaceID, row.EpisodeID, row.DocumentID, row.AttachmentID, row.FileName, row.MimeType, row.ByteLength, row.SourceObjectKey, row.SourceSha256, row.Status, row.FailureCode, row.FailureMessage, row.PageCount, false)
}

func (r PresentingRepository) ListPages(ctx context.Context, document presenting.Document) ([]presenting.Page, error) {
	rows, err := r.queries.ListPresentingDocumentPages(ctx, sqlc.ListPresentingDocumentPagesParams{TenantID: uuid(document.TenantID), SpaceID: uuid(document.SpaceID), DocumentID: uuid(document.DocumentID)})
	if err != nil {
		return nil, fmt.Errorf("list presenting document pages: %w", err)
	}
	pages := make([]presenting.Page, 0, len(rows))
	for _, row := range rows {
		pages = append(pages, presentingPage(row.DocumentID, row.Page, row.Width, row.Height, row.Status, row.ZoomReadyAt, row.ImageKey, row.ThumbnailKey, row.ZoomKey))
	}
	return pages, nil
}

func (r PresentingRepository) AuthorizedPage(ctx context.Context, subject presenting.Subject, documentID utilities.ID, pageNumber int) (presenting.Document, presenting.Page, error) {
	row, err := r.queries.GetAuthorizedPresentingPage(ctx, sqlc.GetAuthorizedPresentingPageParams{
		TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID), EpisodeID: uuid(subject.EpisodeID), DocumentID: uuid(documentID), Page: int32(pageNumber),
		ParticipantID: uuid(subject.ParticipantID), ParticipantGeneration: subject.ParticipantGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return presenting.Document{}, presenting.Page{}, presenting.ErrPageNotFound
	}
	if err != nil {
		return presenting.Document{}, presenting.Page{}, fmt.Errorf("read presenting page: %w", err)
	}
	document := presenting.Document{TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, DocumentID: documentID, Status: row.DocumentStatus}
	return document, presentingPage(row.DocumentID, row.Page, row.Width, row.Height, row.Status, row.ZoomReadyAt, row.ImageKey, row.ThumbnailKey, row.ZoomKey), nil
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
	if rows, err := q.SetPresentingDocumentInventory(ctx, sqlc.SetPresentingDocumentInventoryParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), PageCount: pgtype.Int4{Int32: int32(report.PageCount), Valid: true}}); err != nil || rows != 1 {
		if err == nil {
			err = presenting.ErrLeaseLost
		}
		return nil, fmt.Errorf("store presenting inventory: %w", err)
	}
	for _, page := range report.Pages {
		if page.Page < 1 || page.Page > report.PageCount || page.Width < 1 || page.Height < 1 {
			return nil, presenting.ErrInvalidInput
		}
		if err := q.InsertPresentingDocumentPage(ctx, sqlc.InsertPresentingDocumentPageParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), Page: int32(page.Page), Width: int32(page.Width), Height: int32(page.Height)}); err != nil {
			return nil, fmt.Errorf("store presenting page inventory: %w", err)
		}
	}
	if err := publishPresentingPage(ctx, q, lease, 1); err != nil {
		return nil, err
	}
	if report.PageCount == 1 {
		if _, err := q.CompletePresentingDocumentIfReady(ctx, sqlc.CompletePresentingDocumentIfReadyParams{TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), ReadyPages: pgtype.Int4{Int32: 1, Valid: true}}); err != nil {
			return nil, fmt.Errorf("complete one-page presenting document: %w", err)
		}
	}
	jobs := []presenting.RenderJob{}
	for start := 2; start <= report.PageCount; start += rangeSize {
		end := min(start+rangeSize-1, report.PageCount)
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
	if err := completePresentingJob(ctx, q, lease); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit presenting inventory completion: %w", err)
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
		TenantID: uuid(lease.TenantID), SpaceID: uuid(lease.SpaceID), DocumentID: uuid(lease.DocumentID), JobID: uuid(lease.JobID), AttemptCount: int32(lease.Attempt), LeaseOwner: pgtype.Text{String: lease.LeaseOwner, Valid: true}, LeaseToken: uuid(lease.LeaseToken), NowAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
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

func (r PresentingRepository) ListExpiredDocuments(ctx context.Context, now, endedBefore time.Time, limit int) ([]presenting.Document, error) {
	rows, err := r.queries.ListExpiredPresentingDocuments(ctx, sqlc.ListExpiredPresentingDocumentsParams{
		NowAt: pgtype.Timestamptz{Time: now, Valid: true}, EndedBefore: pgtype.Timestamptz{Time: endedBefore, Valid: true}, BatchLimit: int32(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list expired presenting documents: %w", err)
	}
	documents := make([]presenting.Document, 0, len(rows))
	for _, row := range rows {
		document := presenting.Document{TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), EpisodeID: utilities.IDFromBytes(row.EpisodeID.Bytes), DocumentID: utilities.IDFromBytes(row.DocumentID.Bytes)}
		if row.PageCount.Valid {
			document.PageCount = int(row.PageCount.Int32)
		}
		documents = append(documents, document)
	}
	return documents, nil
}

func (r PresentingRepository) ListDocumentObjectKeys(ctx context.Context, document presenting.Document) ([]string, error) {
	keys, err := r.queries.ListPresentingDocumentObjectKeys(ctx, sqlc.ListPresentingDocumentObjectKeysParams{TenantID: uuid(document.TenantID), SpaceID: uuid(document.SpaceID), DocumentID: uuid(document.DocumentID)})
	if err != nil {
		return nil, fmt.Errorf("list presenting document object keys: %w", err)
	}
	return keys, nil
}

func (r PresentingRepository) DeleteDocument(ctx context.Context, document presenting.Document) error {
	rows, err := r.queries.DeletePresentingDocument(ctx, sqlc.DeletePresentingDocumentParams{TenantID: uuid(document.TenantID), SpaceID: uuid(document.SpaceID), DocumentID: uuid(document.DocumentID)})
	if err != nil {
		return fmt.Errorf("delete presenting document: %w", err)
	}
	if rows != 1 {
		return objectcleanup.ErrLeaseLost
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

func presentingDocument(tenantID, spaceID, episodeID, documentID, attachmentID pgtype.UUID, fileName, mimeType string, byteLength int64, sourceKey string, digest []byte, status string, failureCode, failureMessage pgtype.Text, pageCount pgtype.Int4, created bool) (presenting.Document, error) {
	if len(digest) != 32 {
		return presenting.Document{}, fmt.Errorf("presenting document has invalid source digest")
	}
	var sha [32]byte
	copy(sha[:], digest)
	document := presenting.Document{
		TenantID: utilities.IDFromBytes(tenantID.Bytes), SpaceID: utilities.IDFromBytes(spaceID.Bytes), EpisodeID: utilities.IDFromBytes(episodeID.Bytes),
		DocumentID: utilities.IDFromBytes(documentID.Bytes), AttachmentID: utilities.IDFromBytes(attachmentID.Bytes), FileName: fileName, MIMEType: mimeType,
		ByteLength: byteLength, SourceKey: sourceKey, SourceSHA256: sha, Status: status, Created: created,
	}
	if pageCount.Valid {
		document.PageCount = int(pageCount.Int32)
	}
	if failureCode.Valid {
		document.Failure = &presenting.Failure{Code: failureCode.String, Message: failureMessage.String}
	}
	return document, nil
}

func presentingPage(documentID pgtype.UUID, page, width, height int32, status string, zoomReady pgtype.Timestamptz, imageKey, thumbnailKey, zoomKey pgtype.Text) presenting.Page {
	return presenting.Page{
		DocumentID: utilities.IDFromBytes(documentID.Bytes), Page: int(page), Width: int(width), Height: int(height), Status: status, ZoomReady: zoomReady.Valid,
		ImageKey: imageKey.String, ThumbnailKey: thumbnailKey.String, ZoomKey: zoomKey.String,
	}
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

var _ presenting.Repository = PresentingRepository{}
