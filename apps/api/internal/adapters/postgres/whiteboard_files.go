package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

type WhiteboardFileRepository struct {
	queries whiteboardFileQuerier
}

type whiteboardFileQuerier interface {
	ReserveWhiteboardFileUpload(context.Context, sqlc.ReserveWhiteboardFileUploadParams) (int64, error)
	FailWhiteboardFileUpload(context.Context, pgtype.UUID) (int64, error)
	ClaimWhiteboardFileUploadFinalize(context.Context, sqlc.ClaimWhiteboardFileUploadFinalizeParams) (sqlc.ClaimWhiteboardFileUploadFinalizeRow, error)
	CompleteWhiteboardFileUpload(context.Context, sqlc.CompleteWhiteboardFileUploadParams) (int64, error)
	GetReadyWhiteboardFile(context.Context, sqlc.GetReadyWhiteboardFileParams) (sqlc.GetReadyWhiteboardFileRow, error)
	ClaimWhiteboardFileCleanup(context.Context, sqlc.ClaimWhiteboardFileCleanupParams) ([]sqlc.ClaimWhiteboardFileCleanupRow, error)
	CompleteWhiteboardFileCleanup(context.Context, sqlc.CompleteWhiteboardFileCleanupParams) (int64, error)
}

func NewWhiteboardFileRepository(db sqlc.DBTX) WhiteboardFileRepository {
	return WhiteboardFileRepository{queries: sqlc.New(db)}
}

func (r WhiteboardFileRepository) Reserve(ctx context.Context, input whiteboardfiles.ReserveInput) error {
	upload := input.Upload
	rows, err := r.queries.ReserveWhiteboardFileUpload(ctx, sqlc.ReserveWhiteboardFileUploadParams{
		UploadID: uuid(upload.UploadID), FileID: upload.FileID, ObjectKey: upload.ObjectKey,
		MimeType: upload.MIMEType, ByteLength: upload.ByteLength, Sha256: upload.SHA256[:],
		ExpiresAt: pgtype.Timestamptz{Time: upload.ExpiresAt, Valid: true}, SceneID: uuid(upload.SceneID),
		TenantID: uuid(upload.Subject.TenantID), RoomID: uuid(upload.Subject.RoomID),
		SessionID:             uuid(upload.Subject.SessionID),
		ParticipantSessionID:  uuid(upload.Subject.ParticipantSessionID),
		ParticipantGeneration: upload.Subject.ParticipantGeneration,
	})
	if whiteboardFileUniqueViolation(err) {
		return whiteboardfiles.ErrFileExists
	}
	if err != nil {
		return fmt.Errorf("reserve whiteboard file upload: %w", err)
	}
	if rows != 1 {
		return whiteboardfiles.ErrPermissionDenied
	}
	return nil
}

func (r WhiteboardFileRepository) Fail(ctx context.Context, uploadID utilities.ID) error {
	if _, err := r.queries.FailWhiteboardFileUpload(ctx, uuid(uploadID)); err != nil {
		return fmt.Errorf("fail whiteboard file upload: %w", err)
	}
	return nil
}

func (r WhiteboardFileRepository) ClaimFinalize(ctx context.Context, subject whiteboardfiles.Subject, uploadID utilities.ID, now time.Time) (whiteboardfiles.Upload, error) {
	row, err := r.queries.ClaimWhiteboardFileUploadFinalize(ctx, sqlc.ClaimWhiteboardFileUploadFinalizeParams{
		UploadID: uuid(uploadID), TenantID: uuid(subject.TenantID), RoomID: uuid(subject.RoomID),
		SessionID: uuid(subject.SessionID), ParticipantSessionID: uuid(subject.ParticipantSessionID),
		ParticipantGeneration: subject.ParticipantGeneration,
		NowAt:                 pgtype.Timestamptz{Time: now, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return whiteboardfiles.Upload{}, whiteboardfiles.ErrUploadNotFound
	}
	if err != nil {
		return whiteboardfiles.Upload{}, fmt.Errorf("claim whiteboard upload finalize: %w", err)
	}
	return mapWhiteboardUpload(
		row.UploadID, row.TenantID, row.RoomID, row.SessionID, row.SceneID,
		row.ParticipantSessionID, row.ParticipantGeneration, row.FileID, row.ObjectKey,
		row.MimeType, row.ByteLength, row.Sha256, row.ExpiresAt,
	)
}

func (r WhiteboardFileRepository) Complete(ctx context.Context, input whiteboardfiles.CompleteInput) error {
	rows, err := r.queries.CompleteWhiteboardFileUpload(ctx, sqlc.CompleteWhiteboardFileUploadParams{
		UploadID: uuid(input.UploadID),
		ImmutableObjectIdentity: pgtype.Text{
			String: input.ImmutableObjectIdentity,
			Valid:  true,
		},
	})
	if err != nil {
		return fmt.Errorf("complete whiteboard file upload: %w", err)
	}
	if rows != 1 {
		return whiteboardfiles.ErrUploadNotReady
	}
	return nil
}

func (r WhiteboardFileRepository) ReadyFile(ctx context.Context, subject whiteboardfiles.Subject, fileID string) (whiteboardfiles.Upload, error) {
	row, err := r.queries.GetReadyWhiteboardFile(ctx, sqlc.GetReadyWhiteboardFileParams{
		ParticipantSessionID:  uuid(subject.ParticipantSessionID),
		ParticipantGeneration: subject.ParticipantGeneration,
		TenantID:              uuid(subject.TenantID), RoomID: uuid(subject.RoomID),
		SessionID: uuid(subject.SessionID), FileID: fileID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return whiteboardfiles.Upload{}, whiteboardfiles.ErrFileNotFound
	}
	if err != nil {
		return whiteboardfiles.Upload{}, fmt.Errorf("get ready whiteboard file: %w", err)
	}
	return mapWhiteboardUpload(
		row.UploadID, row.TenantID, row.RoomID, row.SessionID, row.SceneID,
		row.ParticipantSessionID, row.ParticipantGeneration, row.FileID, row.ObjectKey,
		row.MimeType, row.ByteLength, row.Sha256, row.ExpiresAt,
	)
}

func (r WhiteboardFileRepository) ClaimCleanup(ctx context.Context, input whiteboardfiles.CleanupClaimInput) ([]whiteboardfiles.CleanupClaim, error) {
	token, err := utilities.NewID()
	if err != nil {
		return nil, fmt.Errorf("generate whiteboard cleanup token: %w", err)
	}
	rows, err := r.queries.ClaimWhiteboardFileCleanup(ctx, sqlc.ClaimWhiteboardFileCleanupParams{
		ClaimToken: uuid(token),
		LeaseUntil: pgtype.Timestamptz{Time: input.LeaseUntil, Valid: true},
		NowAt:      pgtype.Timestamptz{Time: input.Now, Valid: true},
		EndedBefore: pgtype.Timestamptz{
			Time: input.EndedBefore, Valid: true,
		},
		BatchLimit: int32(input.Limit),
	})
	if err != nil {
		return nil, fmt.Errorf("claim whiteboard file cleanup: %w", err)
	}

	claims := make([]whiteboardfiles.CleanupClaim, 0, len(rows))
	for _, row := range rows {
		claims = append(claims, whiteboardfiles.CleanupClaim{
			UploadID:  utilities.IDFromBytes(row.UploadID.Bytes),
			ObjectKey: row.ObjectKey,
			Token:     token,
		})
	}
	return claims, nil
}

func (r WhiteboardFileRepository) CompleteCleanup(ctx context.Context, claim whiteboardfiles.CleanupClaim) error {
	rows, err := r.queries.CompleteWhiteboardFileCleanup(ctx, sqlc.CompleteWhiteboardFileCleanupParams{
		UploadID: uuid(claim.UploadID), ClaimToken: uuid(claim.Token),
	})
	if err != nil {
		return fmt.Errorf("complete whiteboard file cleanup: %w", err)
	}
	if rows != 1 {
		return whiteboardfiles.ErrCleanupLeaseLost
	}
	return nil
}

func mapWhiteboardUpload(
	uploadID, tenantID, roomID, sessionID, sceneID, participantID pgtype.UUID,
	generation int64,
	fileID, objectKey, mimeType string,
	byteLength int64,
	digest []byte,
	expiresAt pgtype.Timestamptz,
) (whiteboardfiles.Upload, error) {
	if len(digest) != 32 || !expiresAt.Valid {
		return whiteboardfiles.Upload{}, fmt.Errorf("whiteboard upload has invalid durable fields")
	}
	var sha256 [32]byte
	copy(sha256[:], digest)

	return whiteboardfiles.Upload{
		UploadID: utilities.IDFromBytes(uploadID.Bytes),
		Subject: whiteboardfiles.Subject{
			TenantID: utilities.IDFromBytes(tenantID.Bytes), RoomID: utilities.IDFromBytes(roomID.Bytes),
			SessionID: utilities.IDFromBytes(sessionID.Bytes), ParticipantSessionID: utilities.IDFromBytes(participantID.Bytes),
			ParticipantGeneration: generation,
		},
		SceneID: utilities.IDFromBytes(sceneID.Bytes), FileID: fileID, ObjectKey: objectKey,
		MIMEType: mimeType, ByteLength: byteLength, SHA256: sha256, ExpiresAt: expiresAt.Time,
	}, nil
}

func whiteboardFileUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

var _ whiteboardfiles.Repository = WhiteboardFileRepository{}
var _ whiteboardfiles.CleanupRepository = WhiteboardFileRepository{}
