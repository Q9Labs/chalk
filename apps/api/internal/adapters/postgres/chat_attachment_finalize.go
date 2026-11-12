package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/chatattachments"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r ChatAttachmentRepository) ClaimFinalize(
	ctx context.Context,
	subject chatattachments.Subject,
	uploadID utilities.ID,
	now time.Time,
	leaseUntil time.Time,
) (chatattachments.Upload, error) {
	if !leaseUntil.After(now) {
		return chatattachments.Upload{}, chatattachments.ErrInvalidInput
	}
	claimToken, err := utilities.NewID()
	if err != nil {
		return chatattachments.Upload{}, fmt.Errorf("generate chat attachment finalize claim: %w", err)
	}
	row, err := r.queries.ClaimChatAttachmentUploadFinalize(ctx, sqlc.ClaimChatAttachmentUploadFinalizeParams{
		FinalizeClaimToken: uuid(claimToken),
		FinalizeClaimedUntil: pgtype.Timestamptz{
			Time: leaseUntil, Valid: true,
		},
		UploadID: uuid(uploadID), TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID),
		EpisodeID: uuid(subject.EpisodeID), ParticipantID: uuid(subject.ParticipantID),
		ParticipantGeneration: subject.ParticipantGeneration,
		NowAt:                 pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err == nil {
		upload, mapErr := mapChatAttachmentUpload(
			row.AttachmentID, row.UploadID, row.ObjectKey, row.OriginalFilename,
			row.MimeType, row.ByteLength, row.Sha256, row.RequestFingerprint,
			row.Status, row.ExpiresAt,
		)
		if mapErr != nil {
			return chatattachments.Upload{}, mapErr
		}
		if !row.FinalizeClaimToken.Valid || !row.FinalizeClaimedUntil.Valid {
			return chatattachments.Upload{}, fmt.Errorf(
				"chat attachment finalize claim has invalid lease fields",
			)
		}
		upload.FinalizeClaimToken = utilities.IDFromBytes(row.FinalizeClaimToken.Bytes)
		upload.FinalizeClaimedUntil = row.FinalizeClaimedUntil.Time
		return upload, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return chatattachments.Upload{}, fmt.Errorf("claim chat attachment finalize: %w", err)
	}

	existing, findErr := r.queries.GetChatAttachmentByUploadID(ctx, sqlc.GetChatAttachmentByUploadIDParams{
		UploadID: uuid(uploadID), TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID),
		EpisodeID: uuid(subject.EpisodeID), ParticipantID: uuid(subject.ParticipantID),
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
	if input.UploadID.IsZero() ||
		input.FinalizeClaimToken.IsZero() ||
		input.ImmutableObjectIdentity == "" ||
		input.ExpiresAt.IsZero() ||
		input.Now.IsZero() {
		return chatattachments.ErrInvalidInput
	}
	rows, err := r.queries.CompleteChatAttachmentUpload(ctx, sqlc.CompleteChatAttachmentUploadParams{
		UploadID:                uuid(input.UploadID),
		FinalizeClaimToken:      uuid(input.FinalizeClaimToken),
		ImmutableObjectIdentity: pgtype.Text{String: input.ImmutableObjectIdentity, Valid: true},
		ExpiresAt:               pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
		NowAt:                   pgtype.Timestamptz{Time: input.Now, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("complete chat attachment upload: %w", err)
	}
	if rows != 1 {
		return chatattachments.ErrUploadNotReady
	}
	return nil
}

func (r ChatAttachmentRepository) Fail(
	ctx context.Context,
	uploadID utilities.ID,
	finalizeClaimToken utilities.ID,
) error {
	rows, err := r.queries.FailChatAttachmentUpload(
		ctx,
		sqlc.FailChatAttachmentUploadParams{
			UploadID:           uuid(uploadID),
			FinalizeClaimToken: uuid(finalizeClaimToken),
		},
	)
	if err != nil {
		return fmt.Errorf("fail chat attachment upload: %w", err)
	}
	if rows != 1 {
		return chatattachments.ErrUploadNotReady
	}
	return nil
}

func (r ChatAttachmentRepository) ReleaseFinalize(
	ctx context.Context,
	uploadID utilities.ID,
	finalizeClaimToken utilities.ID,
) error {
	if uploadID.IsZero() || finalizeClaimToken.IsZero() {
		return chatattachments.ErrInvalidInput
	}
	rows, err := r.queries.ReleaseChatAttachmentUploadFinalize(
		ctx,
		sqlc.ReleaseChatAttachmentUploadFinalizeParams{
			UploadID:           uuid(uploadID),
			FinalizeClaimToken: uuid(finalizeClaimToken),
		},
	)
	if err != nil {
		return fmt.Errorf("release chat attachment finalize: %w", err)
	}
	if rows != 1 {
		return chatattachments.ErrUploadNotReady
	}
	return nil
}

func (r ChatAttachmentRepository) AuthorizedDownload(ctx context.Context, subject chatattachments.Subject, attachmentID utilities.ID) (chatattachments.Upload, error) {
	row, err := r.queries.GetAuthorizedChatAttachmentDownload(ctx, sqlc.GetAuthorizedChatAttachmentDownloadParams{
		TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID),
		EpisodeID: uuid(subject.EpisodeID), AttachmentID: uuid(attachmentID),
		ParticipantID:         uuid(subject.ParticipantID),
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
			TenantID: utilities.IDFromBytes(row.TenantID.Bytes), EpisodeID: utilities.IDFromBytes(row.EpisodeID.Bytes),
			AttachmentID: utilities.IDFromBytes(row.AttachmentID.Bytes), ObjectKey: row.ObjectKey,
			Token: token,
		})
	}
	return claims, nil
}

func (r ChatAttachmentRepository) CompleteCleanup(ctx context.Context, claim chatattachments.CleanupClaim) error {
	count, err := r.queries.CompleteChatAttachmentCleanup(ctx, sqlc.CompleteChatAttachmentCleanupParams{
		TenantID: uuid(claim.TenantID), EpisodeID: uuid(claim.EpisodeID),
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
