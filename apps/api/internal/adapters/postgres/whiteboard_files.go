package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/whiteboardfiles"
)

type WhiteboardFileRepository struct {
	queries whiteboardFileQuerier
}

type whiteboardFileQuerier interface {
	GetReadyWhiteboardFile(context.Context, sqlc.GetReadyWhiteboardFileParams) (sqlc.GetReadyWhiteboardFileRow, error)
	ClaimWhiteboardFileCleanup(context.Context, sqlc.ClaimWhiteboardFileCleanupParams) ([]sqlc.ClaimWhiteboardFileCleanupRow, error)
	CompleteWhiteboardFileCleanup(context.Context, sqlc.CompleteWhiteboardFileCleanupParams) (int64, error)
}

func NewWhiteboardFileRepository(db sqlc.DBTX) WhiteboardFileRepository {
	return WhiteboardFileRepository{queries: sqlc.New(db)}
}

func (r WhiteboardFileRepository) ReadyFile(ctx context.Context, subject whiteboardfiles.Subject, fileID string) (whiteboardfiles.Upload, error) {
	row, err := r.queries.GetReadyWhiteboardFile(ctx, sqlc.GetReadyWhiteboardFileParams{
		ParticipantID:         uuid(subject.ParticipantID),
		ParticipantGeneration: subject.ParticipantGeneration,
		TenantID:              uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID),
		EpisodeID: uuid(subject.EpisodeID), FileID: fileID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return whiteboardfiles.Upload{}, whiteboardfiles.ErrFileNotFound
	}
	if err != nil {
		return whiteboardfiles.Upload{}, fmt.Errorf("get ready whiteboard file: %w", err)
	}
	return mapWhiteboardUpload(
		row.UploadID, row.TenantID, row.SpaceID, row.EpisodeID, row.SceneID,
		row.ParticipantID, row.ParticipantGeneration, row.FileID, row.ObjectKey,
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
	uploadID, tenantID, spaceID, episodeID, sceneID, participantID pgtype.UUID,
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
			TenantID: utilities.IDFromBytes(tenantID.Bytes), SpaceID: utilities.IDFromBytes(spaceID.Bytes),
			EpisodeID: utilities.IDFromBytes(episodeID.Bytes), ParticipantID: utilities.IDFromBytes(participantID.Bytes),
			ParticipantGeneration: generation,
		},
		SceneID: utilities.IDFromBytes(sceneID.Bytes), FileID: fileID, ObjectKey: objectKey,
		MIMEType: mimeType, ByteLength: byteLength, SHA256: sha256, ExpiresAt: expiresAt.Time,
	}, nil
}

var _ whiteboardfiles.Repository = WhiteboardFileRepository{}
var _ whiteboardfiles.CleanupRepository = WhiteboardFileRepository{}
