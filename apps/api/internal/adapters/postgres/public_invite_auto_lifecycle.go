package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r PublicInviteRepository) CreateAutoLifecycle(ctx context.Context, lifecycle publicinvites.AutoLifecycle) (publicinvites.AutoLifecycle, error) {
	var result publicinvites.AutoLifecycle
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		row, err := queries.CreateAutoSpaceLifecycle(ctx, sqlc.CreateAutoSpaceLifecycleParams{
			TenantID: uuid(lifecycle.TenantID), SpaceID: uuid(lifecycle.SpaceID), DeadlineAt: timestamptz(&lifecycle.DeadlineAt),
			CreatorArrivalHandle: uuid(lifecycle.CreatorArrivalHandle), State: string(lifecycle.State), NextRetryAt: timestamptz(lifecycle.NextRetryAt),
			RetryCount: lifecycle.RetryCount, LastErrorFamily: nullableErrorFamily(lifecycle.LastErrorFamily), ArchiveCompletedAt: timestamptz(lifecycle.ArchiveCompletedAt), JourneyID: uuid(lifecycle.JourneyID),
		})
		if err == nil {
			result = mapAutoLifecycle(row)
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("create auto lifecycle: %w", err)
		}
		row, err = lockAutoLifecycle(ctx, queries, lifecycle.TenantID, lifecycle.SpaceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrAutoLifecycleNotFound
		}
		if err != nil {
			return err
		}
		result = mapAutoLifecycle(row)
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) GetAutoLifecycle(ctx context.Context, tenantID, spaceID utilities.ID) (publicinvites.AutoLifecycle, error) {
	row, err := r.queries.GetAutoSpaceLifecycle(ctx, sqlc.GetAutoSpaceLifecycleParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.AutoLifecycle{}, publicinvites.ErrAutoLifecycleNotFound
	}
	if err != nil {
		return publicinvites.AutoLifecycle{}, fmt.Errorf("get auto lifecycle: %w", err)
	}
	return mapAutoLifecycle(row), nil
}

func (r PublicInviteRepository) ListDueAutoLifecycles(ctx context.Context, now time.Time, pageSize int32) ([]publicinvites.AutoLifecycle, error) {
	rows, err := r.queries.ListDueAutoSpaceLifecycles(ctx, sqlc.ListDueAutoSpaceLifecyclesParams{NowAt: timestamptz(&now), PageSize: pageSize})
	if err != nil {
		return nil, fmt.Errorf("list due auto lifecycles: %w", err)
	}
	result := make([]publicinvites.AutoLifecycle, 0, len(rows))
	for _, row := range rows {
		if row.State == string(publicinvites.AutoLifecycleArchiving) && row.ClaimExpiresAt.Valid && !row.ClaimExpiresAt.Time.After(now) {
			row.State = string(publicinvites.AutoLifecycleActive)
			row.ClaimExpiresAt = pgtype.Timestamptz{}
		}
		result = append(result, mapAutoLifecycle(row))
	}
	return result, nil
}

func (r PublicInviteRepository) MarkAutoLifecycleArchiving(ctx context.Context, tenantID, spaceID utilities.ID) (publicinvites.AutoLifecycle, error) {
	var result publicinvites.AutoLifecycle
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		row, err := lockAutoLifecycle(ctx, queries, tenantID, spaceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrAutoLifecycleNotFound
		}
		if err != nil {
			return err
		}
		if row.State != string(publicinvites.AutoLifecycleActive) {
			return publicinvites.ErrInvalidLifecycleState
		}
		row, err = queries.MarkAutoSpaceLifecycleArchiving(ctx, sqlc.MarkAutoSpaceLifecycleArchivingParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrInvalidLifecycleState
		}
		if err != nil {
			return fmt.Errorf("mark auto lifecycle archiving: %w", err)
		}
		result = mapAutoLifecycle(row)
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) MarkAutoLifecycleArchived(ctx context.Context, tenantID, spaceID utilities.ID) (publicinvites.AutoLifecycle, error) {
	var result publicinvites.AutoLifecycle
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		row, err := lockAutoLifecycle(ctx, queries, tenantID, spaceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrAutoLifecycleNotFound
		}
		if err != nil {
			return err
		}
		if row.State == string(publicinvites.AutoLifecycleArchived) {
			result = mapAutoLifecycle(row)
			return nil
		}
		if row.State != string(publicinvites.AutoLifecycleArchiving) {
			return publicinvites.ErrInvalidLifecycleState
		}
		row, err = queries.MarkAutoSpaceLifecycleArchived(ctx, sqlc.MarkAutoSpaceLifecycleArchivedParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrInvalidLifecycleState
		}
		if err != nil {
			return fmt.Errorf("mark auto lifecycle archived: %w", err)
		}
		result = mapAutoLifecycle(row)
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) RetryAutoLifecycle(ctx context.Context, input publicinvites.RetryAutoLifecycleInput) (publicinvites.AutoLifecycle, error) {
	var result publicinvites.AutoLifecycle
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		row, err := lockAutoLifecycle(ctx, queries, input.TenantID, input.SpaceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrAutoLifecycleNotFound
		}
		if err != nil {
			return err
		}
		if row.State != string(publicinvites.AutoLifecycleArchiving) {
			return publicinvites.ErrInvalidLifecycleState
		}
		row, err = queries.RetryAutoSpaceLifecycle(ctx, sqlc.RetryAutoSpaceLifecycleParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), NextRetryAt: timestamptz(&input.NextRetryAt), LastErrorFamily: nullableErrorFamily(input.ErrorFamily),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrInvalidLifecycleState
		}
		if err != nil {
			return fmt.Errorf("retry auto lifecycle: %w", err)
		}
		result = mapAutoLifecycle(row)
		return nil
	})
	return result, err
}

func lockAutoLifecycle(ctx context.Context, queries publicInviteQuerier, tenantID, spaceID utilities.ID) (sqlc.AutoSpaceLifecycle, error) {
	row, err := queries.LockAutoSpaceLifecycle(ctx, sqlc.LockAutoSpaceLifecycleParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return sqlc.AutoSpaceLifecycle{}, publicinvites.ErrAutoLifecycleNotFound
		}
		return sqlc.AutoSpaceLifecycle{}, fmt.Errorf("lock auto lifecycle: %w", err)
	}
	return row, nil
}

func mapAutoLifecycle(row sqlc.AutoSpaceLifecycle) publicinvites.AutoLifecycle {
	return publicinvites.AutoLifecycle{
		TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), DeadlineAt: timestamp(row.DeadlineAt), CreatorArrivalHandle: nullableID(row.CreatorArrivalHandle),
		State: publicinvites.AutoLifecycleState(row.State), NextRetryAt: nullableTimestamp(row.NextRetryAt), RetryCount: row.RetryCount, LastErrorFamily: publicInviteNullableString(row.LastErrorFamily),
		ArchiveCompletedAt: nullableTimestamp(row.ArchiveCompletedAt), JourneyID: nullableID(row.JourneyID), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt),
	}
}
