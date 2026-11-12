package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type publicInviteQuerier interface {
	LockLifecycleEpisodeForUpdate(context.Context, sqlc.LockLifecycleEpisodeForUpdateParams) (sqlc.Episode, error)
	LockLifecycleParticipantForUpdate(context.Context, sqlc.LockLifecycleParticipantForUpdateParams) (sqlc.Participant, error)
	LockTenantSpaceForAdmission(context.Context, sqlc.LockTenantSpaceForAdmissionParams) (sqlc.Space, error)
	GetPublicAdmissionBinding(context.Context, sqlc.GetPublicAdmissionBindingParams) (sqlc.GetPublicAdmissionBindingRow, error)
	CreateAutoSpaceLifecycle(context.Context, sqlc.CreateAutoSpaceLifecycleParams) (sqlc.AutoSpaceLifecycle, error)
	CreateSpacePublicAdmissionRequest(context.Context, sqlc.CreateSpacePublicAdmissionRequestParams) (sqlc.SpacePublicAdmissionRequest, error)
	CreateSpacePublicArrival(context.Context, sqlc.CreateSpacePublicArrivalParams) (sqlc.SpacePublicArrival, error)
	CreateSpacePublicInvite(context.Context, sqlc.CreateSpacePublicInviteParams) (sqlc.SpacePublicInvite, error)
	GetAutoSpaceLifecycle(context.Context, sqlc.GetAutoSpaceLifecycleParams) (sqlc.AutoSpaceLifecycle, error)
	GetSpacePublicAdmissionRequest(context.Context, sqlc.GetSpacePublicAdmissionRequestParams) (sqlc.GetSpacePublicAdmissionRequestRow, error)
	GetSpacePublicAdmissionRequestForArrival(context.Context, sqlc.GetSpacePublicAdmissionRequestForArrivalParams) (sqlc.GetSpacePublicAdmissionRequestForArrivalRow, error)
	GetSpacePublicArrival(context.Context, pgtype.UUID) (sqlc.SpacePublicArrival, error)
	GetSpacePublicArrivalByIdempotency(context.Context, sqlc.GetSpacePublicArrivalByIdempotencyParams) (sqlc.SpacePublicArrival, error)
	GetSpacePublicArrivalForCredential(context.Context, sqlc.GetSpacePublicArrivalForCredentialParams) (sqlc.SpacePublicArrival, error)
	GetSpacePublicInvite(context.Context, sqlc.GetSpacePublicInviteParams) (sqlc.SpacePublicInvite, error)
	GetSpacePublicInviteByHandle(context.Context, []byte) (sqlc.SpacePublicInvite, error)
	GetSpacePublicInviteByCode(context.Context, string) (sqlc.SpacePublicInvite, error)
	ListDueAutoSpaceLifecycles(context.Context, sqlc.ListDueAutoSpaceLifecyclesParams) ([]sqlc.AutoSpaceLifecycle, error)
	ListPendingSpacePublicAdmissionRequests(context.Context, sqlc.ListPendingSpacePublicAdmissionRequestsParams) ([]sqlc.ListPendingSpacePublicAdmissionRequestsRow, error)
	LockSpacePublicAdmissionRequest(context.Context, sqlc.LockSpacePublicAdmissionRequestParams) (sqlc.SpacePublicAdmissionRequest, error)
	LockSpacePublicArrival(context.Context, pgtype.UUID) (sqlc.SpacePublicArrival, error)
	LockSpacePublicArrivalByIdempotency(context.Context, sqlc.LockSpacePublicArrivalByIdempotencyParams) (sqlc.SpacePublicArrival, error)
	LockAutoSpaceLifecycle(context.Context, sqlc.LockAutoSpaceLifecycleParams) (sqlc.AutoSpaceLifecycle, error)
	LockSpacePublicInvite(context.Context, sqlc.LockSpacePublicInviteParams) (sqlc.SpacePublicInvite, error)
	LockSpacePublicInviteByHandle(context.Context, []byte) (sqlc.SpacePublicInvite, error)
	MarkAutoSpaceLifecycleArchived(context.Context, sqlc.MarkAutoSpaceLifecycleArchivedParams) (sqlc.AutoSpaceLifecycle, error)
	MarkAutoSpaceLifecycleArchiving(context.Context, sqlc.MarkAutoSpaceLifecycleArchivingParams) (sqlc.AutoSpaceLifecycle, error)
	RetryAutoSpaceLifecycle(context.Context, sqlc.RetryAutoSpaceLifecycleParams) (sqlc.AutoSpaceLifecycle, error)
	RotateSpacePublicInvite(context.Context, sqlc.RotateSpacePublicInviteParams) (sqlc.SpacePublicInvite, error)
	UpdateSpacePublicAdmissionRequest(context.Context, sqlc.UpdateSpacePublicAdmissionRequestParams) (sqlc.SpacePublicAdmissionRequest, error)
	UpdateSpacePublicArrivalState(context.Context, sqlc.UpdateSpacePublicArrivalStateParams) (sqlc.SpacePublicArrival, error)
	RecordPublicAdmissionCancellation(context.Context, sqlc.RecordPublicAdmissionCancellationParams) error
	UpdateSpacePublicInviteEnabled(context.Context, sqlc.UpdateSpacePublicInviteEnabledParams) (sqlc.SpacePublicInvite, error)
}

type publicInviteTransactor interface {
	Begin(context.Context) (pgx.Tx, error)
}

// PublicInviteRepository persists the public Space invite and arrival state.
// Mutations run in a transaction when a transactor is configured. The direct
// query path exists for small unit fakes; production constructors always pass
// a pool so row locks are held for the whole mutation.
type PublicInviteRepository struct {
	queries    publicInviteQuerier
	transactor publicInviteTransactor
	lifecycle  EpisodeLifecycleRepository
}

var _ publicinvites.Repository = PublicInviteRepository{}
var _ publicinvites.Lifecycle = PublicInviteRepository{}

func NewPublicInviteRepository(queries publicInviteQuerier, transactors ...publicInviteTransactor) PublicInviteRepository {
	repository := PublicInviteRepository{queries: queries}
	if len(transactors) > 0 {
		repository.transactor = transactors[0]
	}
	return repository
}

func NewPublicInviteRepositoryWithPool(pool *pgxpool.Pool) PublicInviteRepository {
	repository := NewPublicInviteRepository(sqlc.New(pool), pool)
	repository.lifecycle = NewEpisodeLifecycleRepository(pool)
	return repository
}

func (r PublicInviteRepository) WithEpisodeLifecycle(lifecycle EpisodeLifecycleRepository) PublicInviteRepository {
	r.lifecycle = lifecycle
	return r
}

func NewPublicInvitesRepositoryWithPool(pool *pgxpool.Pool) PublicInviteRepository {
	return NewPublicInviteRepositoryWithPool(pool)
}

// PublicInvitesRepository is kept as an alias for callers that use the
// package name in the type name.
type PublicInvitesRepository = PublicInviteRepository

func NewPublicInvitesRepository(queries publicInviteQuerier, transactors ...publicInviteTransactor) PublicInviteRepository {
	return NewPublicInviteRepository(queries, transactors...)
}

func (r PublicInviteRepository) CreateOrGetInvite(ctx context.Context, invite publicinvites.Invite) (publicinvites.Invite, error) {
	var result publicinvites.Invite
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		row, err := queries.CreateSpacePublicInvite(ctx, sqlc.CreateSpacePublicInviteParams{
			TenantID:      uuid(invite.TenantID),
			SpaceID:       uuid(invite.SpaceID),
			Handle:        append([]byte(nil), invite.Handle...),
			Generation:    int64(invite.Generation),
			StateEpoch:    int64(invite.StateEpoch),
			AdmissionMode: string(invite.AdmissionMode),
			LastActorID:   uuid(invite.LastActorID),
		})
		if err == nil {
			result = mapPublicInvite(row)
			return nil
		}
		if uniqueConstraintViolation(err, "space_public_invites_invite_code_idx") || uniqueConstraintViolation(err, "space_public_invites_invite_words_idx") {
			return publicinvites.ErrInviteCodeTaken
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("create public invite: %w", err)
		}

		row, err = queries.LockSpacePublicInvite(ctx, sqlc.LockSpacePublicInviteParams{
			TenantID: uuid(invite.TenantID),
			SpaceID:  uuid(invite.SpaceID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrInviteNotFound
		}
		if err != nil {
			return fmt.Errorf("lock public invite materialization: %w", err)
		}
		result = mapPublicInvite(row)
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) GetInvite(ctx context.Context, tenantID, spaceID utilities.ID) (publicinvites.Invite, error) {
	row, err := r.queries.GetSpacePublicInvite(ctx, sqlc.GetSpacePublicInviteParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.Invite{}, publicinvites.ErrInviteNotFound
	}
	if err != nil {
		return publicinvites.Invite{}, fmt.Errorf("get public invite: %w", err)
	}
	return mapPublicInvite(row), nil
}

func (r PublicInviteRepository) GetInviteByHandle(ctx context.Context, handle []byte) (publicinvites.Invite, error) {
	row, err := r.queries.GetSpacePublicInviteByHandle(ctx, handle)
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.Invite{}, publicinvites.ErrInviteNotFound
	}
	if err != nil {
		return publicinvites.Invite{}, fmt.Errorf("get public invite by handle: %w", err)
	}
	return mapPublicInvite(row), nil
}

func (r PublicInviteRepository) GetInviteByCode(ctx context.Context, code string) (publicinvites.Invite, error) {
	row, err := r.queries.GetSpacePublicInviteByCode(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.Invite{}, publicinvites.ErrInviteNotFound
	}
	if err != nil {
		return publicinvites.Invite{}, fmt.Errorf("get public invite by code: %w", err)
	}
	return mapPublicInvite(row), nil
}

func (r PublicInviteRepository) SetInviteEnabled(ctx context.Context, tenantID, spaceID utilities.ID, enabled bool, actorID utilities.ID) (publicinvites.Invite, error) {
	var result publicinvites.Invite
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		locked, err := r.lockInvite(ctx, queries, tenantID, spaceID)
		if err != nil {
			return err
		}
		if locked.Enabled == enabled {
			result = mapPublicInvite(locked)
			return nil
		}
		row, err := queries.UpdateSpacePublicInviteEnabled(ctx, sqlc.UpdateSpacePublicInviteEnabledParams{
			Enabled: enabled, LastActorID: uuid(actorID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrInviteNotFound
		}
		if err != nil {
			return fmt.Errorf("set public invite enabled: %w", err)
		}
		result = mapPublicInvite(row)
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) RotateInvite(ctx context.Context, tenantID, spaceID utilities.ID, handle []byte, actorID utilities.ID, requestKey string) (publicinvites.Invite, error) {
	var result publicinvites.Invite
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		locked, err := r.lockInvite(ctx, queries, tenantID, spaceID)
		if err != nil {
			return err
		}
		if requestKey != "" && locked.LastRotationRequestKey.Valid && locked.LastRotationRequestKey.String == requestKey {
			result = mapPublicInvite(locked)
			return nil
		}
		row, err := queries.RotateSpacePublicInvite(ctx, sqlc.RotateSpacePublicInviteParams{
			Handle: handle, LastActorID: uuid(actorID), LastRotationRequestKey: textValue(requestKey), TenantID: uuid(tenantID), SpaceID: uuid(spaceID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrInviteNotFound
		}
		if uniqueConstraintViolation(err, "space_public_invites_invite_code_idx") || uniqueConstraintViolation(err, "space_public_invites_invite_words_idx") {
			return publicinvites.ErrInviteCodeTaken
		}
		if err != nil {
			return fmt.Errorf("rotate public invite: %w", err)
		}
		result = mapPublicInvite(row)
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) mutate(ctx context.Context, work func(publicInviteQuerier) error) error {
	if r.transactor == nil {
		return work(r.queries)
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin public invite transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := work(sqlc.New(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit public invite transaction: %w", err)
	}
	return nil
}

func (r PublicInviteRepository) lockInvite(ctx context.Context, queries publicInviteQuerier, tenantID, spaceID utilities.ID) (sqlc.SpacePublicInvite, error) {
	row, err := queries.LockSpacePublicInvite(ctx, sqlc.LockSpacePublicInviteParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SpacePublicInvite{}, publicinvites.ErrInviteNotFound
	}
	if err != nil {
		return sqlc.SpacePublicInvite{}, fmt.Errorf("lock public invite: %w", err)
	}
	return row, nil
}
