package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ChatAttachmentRepository struct {
	queries chatAttachmentQuerier
}

type chatAttachmentQuerier interface {
	ReserveChatAttachmentUpload(context.Context, sqlc.ReserveChatAttachmentUploadParams) (sqlc.ReserveChatAttachmentUploadRow, error)
	GetChatAttachmentByClientID(context.Context, sqlc.GetChatAttachmentByClientIDParams) (sqlc.GetChatAttachmentByClientIDRow, error)
	GetChatAttachmentByUploadID(context.Context, sqlc.GetChatAttachmentByUploadIDParams) (sqlc.GetChatAttachmentByUploadIDRow, error)
	ClaimChatAttachmentUploadFinalize(context.Context, sqlc.ClaimChatAttachmentUploadFinalizeParams) (sqlc.ClaimChatAttachmentUploadFinalizeRow, error)
	FailChatAttachmentUpload(context.Context, pgtype.UUID) (int64, error)
	CompleteChatAttachmentUpload(context.Context, sqlc.CompleteChatAttachmentUploadParams) (int64, error)
	GetAuthorizedChatAttachmentDownload(context.Context, sqlc.GetAuthorizedChatAttachmentDownloadParams) (sqlc.GetAuthorizedChatAttachmentDownloadRow, error)
	ClaimChatAttachmentCleanup(context.Context, sqlc.ClaimChatAttachmentCleanupParams) ([]sqlc.ClaimChatAttachmentCleanupRow, error)
	CompleteChatAttachmentCleanup(context.Context, sqlc.CompleteChatAttachmentCleanupParams) (int64, error)
}

func NewChatAttachmentRepository(db sqlc.DBTX) ChatAttachmentRepository {
	return ChatAttachmentRepository{queries: sqlc.New(db)}
}

func (r ChatAttachmentRepository) Reserve(ctx context.Context, input chatattachments.ReserveInput) (chatattachments.Upload, error) {
	upload := input.Upload
	row, err := r.queries.ReserveChatAttachmentUpload(ctx, sqlc.ReserveChatAttachmentUploadParams{
		AttachmentID: uuid(upload.AttachmentID), ClientAttachmentID: input.ClientAttachmentID,
		RequestFingerprint: upload.RequestFingerprint[:], UploadID: uuid(upload.UploadID),
		ObjectKey: upload.ObjectKey, OriginalFilename: upload.FileName, MimeType: upload.MIMEType,
		ByteLength: upload.ByteLength, Sha256: upload.SHA256[:],
		ExpiresAt: pgtype.Timestamptz{Time: upload.ExpiresAt, Valid: true},
		TenantID:  uuid(input.Subject.TenantID), RoomID: uuid(input.Subject.RoomID),
		SessionID: uuid(input.Subject.SessionID), ParticipantSessionID: uuid(input.Subject.ParticipantSessionID),
		ParticipantGeneration: input.Subject.ParticipantGeneration,
	})
	if chatAttachmentUniqueViolation(err) {
		return r.existingReservation(ctx, input)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return chatattachments.Upload{}, chatattachments.ErrQuotaExceeded
	}
	if err != nil {
		return chatattachments.Upload{}, fmt.Errorf("reserve chat attachment upload: %w", err)
	}
	return mapChatAttachmentUpload(
		row.AttachmentID, row.UploadID, row.ObjectKey, row.OriginalFilename,
		row.MimeType, row.ByteLength, row.Sha256, row.RequestFingerprint,
		row.Status, row.ExpiresAt,
	)
}

func (r ChatAttachmentRepository) existingReservation(ctx context.Context, input chatattachments.ReserveInput) (chatattachments.Upload, error) {
	subject := input.Subject
	row, err := r.queries.GetChatAttachmentByClientID(ctx, sqlc.GetChatAttachmentByClientIDParams{
		TenantID: uuid(subject.TenantID), RoomID: uuid(subject.RoomID),
		SessionID: uuid(subject.SessionID), ParticipantSessionID: uuid(subject.ParticipantSessionID),
		ParticipantGeneration: subject.ParticipantGeneration, ClientAttachmentID: input.ClientAttachmentID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return chatattachments.Upload{}, chatattachments.ErrClientAttachmentIDConflict
	}
	if err != nil {
		return chatattachments.Upload{}, fmt.Errorf("read duplicate chat attachment upload: %w", err)
	}
	upload, err := mapChatAttachmentUpload(
		row.AttachmentID, row.UploadID, row.ObjectKey, row.OriginalFilename,
		row.MimeType, row.ByteLength, row.Sha256, row.RequestFingerprint,
		row.Status, row.ExpiresAt,
	)
	if err != nil {
		return chatattachments.Upload{}, err
	}
	if !bytes.Equal(upload.RequestFingerprint[:], input.Upload.RequestFingerprint[:]) {
		return chatattachments.Upload{}, chatattachments.ErrClientAttachmentIDConflict
	}
	return upload, nil
}

func (r ChatAttachmentRepository) ClaimFinalize(ctx context.Context, subject chatattachments.Subject, uploadID utilities.ID, now time.Time) (chatattachments.Upload, error) {
	row, err := r.queries.ClaimChatAttachmentUploadFinalize(ctx, sqlc.ClaimChatAttachmentUploadFinalizeParams{
		UploadID: uuid(uploadID), TenantID: uuid(subject.TenantID), RoomID: uuid(subject.RoomID),
		SessionID: uuid(subject.SessionID), ParticipantSessionID: uuid(subject.ParticipantSessionID),
		ParticipantGeneration: subject.ParticipantGeneration,
		NowAt:                 pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err == nil {
		return mapChatAttachmentUpload(
			row.AttachmentID, row.UploadID, row.ObjectKey, row.OriginalFilename,
			row.MimeType, row.ByteLength, row.Sha256, row.RequestFingerprint,
			row.Status, row.ExpiresAt,
		)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return chatattachments.Upload{}, fmt.Errorf("claim chat attachment finalize: %w", err)
	}

	existing, findErr := r.queries.GetChatAttachmentByUploadID(ctx, sqlc.GetChatAttachmentByUploadIDParams{
		UploadID: uuid(uploadID), TenantID: uuid(subject.TenantID), RoomID: uuid(subject.RoomID),
		SessionID: uuid(subject.SessionID), ParticipantSessionID: uuid(subject.ParticipantSessionID),
		ParticipantGeneration: subject.ParticipantGeneration,
	})
	if errors.Is(findErr, pgx.ErrNoRows) {
		return chatattachments.Upload{}, chatattachments.ErrUploadNotFound
	}
	if findErr != nil {
		return chatattachments.Upload{}, fmt.Errorf("read chat attachment finalize state: %w", findErr)
	}
	upload, mapErr := mapChatAttachmentUpload(
		existing.AttachmentID, existing.UploadID, existing.ObjectKey, existing.OriginalFilename,
		existing.MimeType, existing.ByteLength, existing.Sha256, existing.RequestFingerprint,
		existing.Status, existing.ExpiresAt,
	)
	if mapErr != nil {
		return chatattachments.Upload{}, mapErr
	}
	if upload.Status == "ready" || upload.Status == "attached" {
		return upload, nil
	}
	if !upload.ExpiresAt.After(now) {
		return chatattachments.Upload{}, chatattachments.ErrUploadExpired
	}
	return chatattachments.Upload{}, chatattachments.ErrUploadNotReady
}

func (r ChatAttachmentRepository) Complete(ctx context.Context, input chatattachments.CompleteInput) error {
	rows, err := r.queries.CompleteChatAttachmentUpload(ctx, sqlc.CompleteChatAttachmentUploadParams{
		UploadID:                uuid(input.UploadID),
		ImmutableObjectIdentity: pgtype.Text{String: input.ImmutableObjectIdentity, Valid: true},
		ExpiresAt:               pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("complete chat attachment upload: %w", err)
	}
	if rows != 1 {
		return chatattachments.ErrUploadNotReady
	}
	return nil
}

func (r ChatAttachmentRepository) Fail(ctx context.Context, uploadID utilities.ID) error {
	if _, err := r.queries.FailChatAttachmentUpload(ctx, uuid(uploadID)); err != nil {
		return fmt.Errorf("fail chat attachment upload: %w", err)
	}
	return nil
}

func (r ChatAttachmentRepository) AuthorizedDownload(ctx context.Context, subject chatattachments.Subject, attachmentID utilities.ID) (chatattachments.Upload, error) {
	row, err := r.queries.GetAuthorizedChatAttachmentDownload(ctx, sqlc.GetAuthorizedChatAttachmentDownloadParams{
		TenantID: uuid(subject.TenantID), RoomID: uuid(subject.RoomID),
		SessionID: uuid(subject.SessionID), AttachmentID: uuid(attachmentID),
		ParticipantSessionID:  uuid(subject.ParticipantSessionID),
		ParticipantGeneration: subject.ParticipantGeneration,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return chatattachments.Upload{}, chatattachments.ErrAttachmentNotFound
	}
	if err != nil {
		return chatattachments.Upload{}, fmt.Errorf("authorize chat attachment download: %w", err)
	}
	return mapChatAttachmentUpload(
		row.AttachmentID, row.UploadID, row.ObjectKey, row.OriginalFilename,
		row.MimeType, row.ByteLength, row.Sha256, row.RequestFingerprint,
		row.Status, row.ExpiresAt,
	)
}

func (r ChatAttachmentRepository) ClaimCleanup(ctx context.Context, input chatattachments.CleanupClaimInput) ([]chatattachments.CleanupClaim, error) {
	token, err := utilities.NewID()
	if err != nil {
		return nil, fmt.Errorf("generate chat attachment cleanup token: %w", err)
	}
	rows, err := r.queries.ClaimChatAttachmentCleanup(ctx, sqlc.ClaimChatAttachmentCleanupParams{
		ClaimToken: uuid(token),
		LeaseUntil: pgtype.Timestamptz{Time: input.LeaseUntil, Valid: true},
		NowAt:      pgtype.Timestamptz{Time: input.Now, Valid: true},
		EndedBefore: pgtype.Timestamptz{
			Time: input.EndedBefore, Valid: true,
		},
		BatchLimit: int32(input.Limit),
	})
	if err != nil {
		return nil, fmt.Errorf("claim chat attachment cleanup: %w", err)
	}
	claims := make([]chatattachments.CleanupClaim, 0, len(rows))
	for _, row := range rows {
		claims = append(claims, chatattachments.CleanupClaim{
			TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SessionID: utilities.IDFromBytes(row.SessionID.Bytes),
			AttachmentID: utilities.IDFromBytes(row.AttachmentID.Bytes), ObjectKey: row.ObjectKey,
			Token: token,
		})
	}
	return claims, nil
}

func (r ChatAttachmentRepository) CompleteCleanup(ctx context.Context, claim chatattachments.CleanupClaim) error {
	count, err := r.queries.CompleteChatAttachmentCleanup(ctx, sqlc.CompleteChatAttachmentCleanupParams{
		TenantID: uuid(claim.TenantID), SessionID: uuid(claim.SessionID),
		AttachmentID: uuid(claim.AttachmentID), ClaimToken: uuid(claim.Token),
	})
	if err != nil {
		return fmt.Errorf("complete chat attachment cleanup: %w", err)
	}
	if count != 1 {
		return chatattachments.ErrCleanupLeaseLost
	}
	return nil
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
