package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ChatAttachmentRepository struct {
	queries chatAttachmentQuerier
	db      chatAttachmentDB
}

type chatAttachmentDB interface {
	sqlc.DBTX
	Begin(context.Context) (pgx.Tx, error)
}

type chatAttachmentQuerier interface {
	ReserveChatAttachmentUpload(context.Context, sqlc.ReserveChatAttachmentUploadParams) (sqlc.ReserveChatAttachmentUploadRow, error)
	GetChatAttachmentByClientID(context.Context, sqlc.GetChatAttachmentByClientIDParams) (sqlc.GetChatAttachmentByClientIDRow, error)
	GetChatAttachmentByUploadID(context.Context, sqlc.GetChatAttachmentByUploadIDParams) (sqlc.GetChatAttachmentByUploadIDRow, error)
	ClaimChatAttachmentUploadFinalize(context.Context, sqlc.ClaimChatAttachmentUploadFinalizeParams) (sqlc.ClaimChatAttachmentUploadFinalizeRow, error)
	FailChatAttachmentUpload(context.Context, sqlc.FailChatAttachmentUploadParams) (int64, error)
	ReleaseChatAttachmentUploadFinalize(context.Context, sqlc.ReleaseChatAttachmentUploadFinalizeParams) (int64, error)
	CompleteChatAttachmentUpload(context.Context, sqlc.CompleteChatAttachmentUploadParams) (int64, error)
	GetAuthorizedChatAttachmentDownload(context.Context, sqlc.GetAuthorizedChatAttachmentDownloadParams) (sqlc.GetAuthorizedChatAttachmentDownloadRow, error)
	ClaimChatAttachmentCleanup(context.Context, sqlc.ClaimChatAttachmentCleanupParams) ([]sqlc.ClaimChatAttachmentCleanupRow, error)
	CompleteChatAttachmentCleanup(context.Context, sqlc.CompleteChatAttachmentCleanupParams) (int64, error)
}

func NewChatAttachmentRepository(db chatAttachmentDB) ChatAttachmentRepository {
	return ChatAttachmentRepository{queries: sqlc.New(db), db: db}
}

func (r ChatAttachmentRepository) Reserve(ctx context.Context, input chatattachments.ReserveInput) (chatattachments.Upload, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return chatattachments.Upload{}, fmt.Errorf("begin chat attachment reservation: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	subject := input.Subject
	_, err = queries.LockChatAttachmentStream(ctx, sqlc.LockChatAttachmentStreamParams{
		TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID),
		EpisodeID: uuid(subject.EpisodeID), ParticipantID: uuid(subject.ParticipantID),
		ParticipantGeneration: subject.ParticipantGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return chatattachments.Upload{}, chatattachments.ErrQuotaExceeded
	}
	if err != nil {
		return chatattachments.Upload{}, fmt.Errorf("lock chat attachment stream: %w", err)
	}
	// A retry of a stored reservation returns it even when the person is now at the cap.
	existing, found, err := findReservation(ctx, queries, input)
	if err != nil || found {
		return existing, err
	}
	upload := input.Upload
	row, err := queries.ReserveChatAttachmentUpload(ctx, sqlc.ReserveChatAttachmentUploadParams{
		AttachmentID: uuid(upload.AttachmentID), ClientAttachmentID: input.ClientAttachmentID,
		RequestFingerprint: upload.RequestFingerprint[:], UploadID: uuid(upload.UploadID),
		ObjectKey: upload.ObjectKey, OriginalFilename: upload.FileName, MimeType: upload.MIMEType,
		ByteLength: upload.ByteLength, Sha256: upload.SHA256[:],
		ExpiresAt: pgtype.Timestamptz{Time: upload.ExpiresAt, Valid: true},
		TenantID:  uuid(input.Subject.TenantID), SpaceID: uuid(input.Subject.SpaceID),
		EpisodeID: uuid(input.Subject.EpisodeID), ParticipantID: uuid(input.Subject.ParticipantID),
		ParticipantGeneration: input.Subject.ParticipantGeneration,
	})
	if chatAttachmentUniqueViolation(err) {
		// The failed insert aborted the transaction, so the conflict is read outside it.
		_ = tx.Rollback(ctx)
		existing, found, err := findReservation(ctx, r.queries, input)
		if err == nil && !found {
			return chatattachments.Upload{}, chatattachments.ErrClientAttachmentIDConflict
		}
		return existing, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return chatattachments.Upload{}, chatattachments.ErrQuotaExceeded
	}
	if err != nil {
		return chatattachments.Upload{}, fmt.Errorf("reserve chat attachment upload: %w", err)
	}
	reserved, err := mapChatAttachmentUpload(
		row.AttachmentID, row.UploadID, row.ObjectKey, row.OriginalFilename,
		row.MimeType, row.ByteLength, row.Sha256, row.RequestFingerprint,
		row.Status, row.ExpiresAt,
	)
	if err != nil {
		return chatattachments.Upload{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return chatattachments.Upload{}, fmt.Errorf("commit chat attachment reservation: %w", err)
	}
	return reserved, nil
}

// findReservation returns the Participant's stored reservation for the client attachment ID. A stored
// reservation with a different request is a conflict.
func findReservation(ctx context.Context, queries chatAttachmentQuerier, input chatattachments.ReserveInput) (chatattachments.Upload, bool, error) {
	subject := input.Subject
	row, err := queries.GetChatAttachmentByClientID(ctx, sqlc.GetChatAttachmentByClientIDParams{
		TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID),
		EpisodeID: uuid(subject.EpisodeID), ParticipantID: uuid(subject.ParticipantID),
		ParticipantGeneration: subject.ParticipantGeneration, ClientAttachmentID: input.ClientAttachmentID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return chatattachments.Upload{}, false, nil
	}
	if err != nil {
		return chatattachments.Upload{}, false, fmt.Errorf("read duplicate chat attachment upload: %w", err)
	}
	upload, err := mapChatAttachmentUpload(
		row.AttachmentID, row.UploadID, row.ObjectKey, row.OriginalFilename,
		row.MimeType, row.ByteLength, row.Sha256, row.RequestFingerprint,
		row.Status, row.ExpiresAt,
	)
	if err != nil {
		return chatattachments.Upload{}, false, err
	}
	if !bytes.Equal(upload.RequestFingerprint[:], input.Upload.RequestFingerprint[:]) {
		return chatattachments.Upload{}, false, chatattachments.ErrClientAttachmentIDConflict
	}
	return upload, true, nil
}

func mapChatAttachmentUpload(
	attachmentID, uploadID pgtype.UUID,
	objectKey, fileName, mimeType string,
	byteLength int64,
	digest, fingerprint []byte,
	status string,
	expiresAt pgtype.Timestamptz,
) (chatattachments.Upload, error) {
	if len(digest) != sha256Size || len(fingerprint) != sha256Size || !expiresAt.Valid {
		return chatattachments.Upload{}, fmt.Errorf("chat attachment upload has invalid durable fields")
	}
	var sha [sha256Size]byte
	var requestFingerprint [sha256Size]byte
	copy(sha[:], digest)
	copy(requestFingerprint[:], fingerprint)
	return chatattachments.Upload{
		Attachment: chatattachments.Attachment{
			AttachmentID: utilities.IDFromBytes(attachmentID.Bytes),
			FileName:     fileName, MIMEType: mimeType, ByteLength: byteLength,
		},
		UploadID: utilities.IDFromBytes(uploadID.Bytes), ObjectKey: objectKey,
		SHA256: sha, RequestFingerprint: requestFingerprint, Status: status,
		ExpiresAt: expiresAt.Time,
	}, nil
}

func chatAttachmentUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

const sha256Size = 32

var _ chatattachments.Repository = ChatAttachmentRepository{}
var _ chatattachments.CleanupRepository = ChatAttachmentRepository{}
