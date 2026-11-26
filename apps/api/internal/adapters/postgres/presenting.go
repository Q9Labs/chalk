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

var _ presenting.Repository = PresentingRepository{}
