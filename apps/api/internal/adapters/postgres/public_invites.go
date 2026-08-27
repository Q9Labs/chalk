package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type publicInviteQuerier interface {
	CreateAutoSpaceLifecycle(context.Context, sqlc.CreateAutoSpaceLifecycleParams) (sqlc.AutoSpaceLifecycle, error)
	CreateSpacePublicAdmissionRequest(context.Context, sqlc.CreateSpacePublicAdmissionRequestParams) (sqlc.SpacePublicAdmissionRequest, error)
	CreateSpacePublicArrival(context.Context, sqlc.CreateSpacePublicArrivalParams) (sqlc.SpacePublicArrival, error)
	CreateSpacePublicInvite(context.Context, sqlc.CreateSpacePublicInviteParams) (sqlc.SpacePublicInvite, error)
	GetAutoSpaceLifecycle(context.Context, sqlc.GetAutoSpaceLifecycleParams) (sqlc.AutoSpaceLifecycle, error)
	GetSpacePublicAdmissionRequest(context.Context, sqlc.GetSpacePublicAdmissionRequestParams) (sqlc.SpacePublicAdmissionRequest, error)
	GetSpacePublicArrival(context.Context, pgtype.UUID) (sqlc.SpacePublicArrival, error)
	GetSpacePublicArrivalByIdempotency(context.Context, sqlc.GetSpacePublicArrivalByIdempotencyParams) (sqlc.SpacePublicArrival, error)
	GetSpacePublicArrivalForCredential(context.Context, sqlc.GetSpacePublicArrivalForCredentialParams) (sqlc.SpacePublicArrival, error)
	GetSpacePublicInvite(context.Context, sqlc.GetSpacePublicInviteParams) (sqlc.SpacePublicInvite, error)
	GetSpacePublicInviteByHandle(context.Context, []byte) (sqlc.SpacePublicInvite, error)
	ListDueAutoSpaceLifecycles(context.Context, sqlc.ListDueAutoSpaceLifecyclesParams) ([]sqlc.AutoSpaceLifecycle, error)
	ListPendingSpacePublicAdmissionRequests(context.Context, sqlc.ListPendingSpacePublicAdmissionRequestsParams) ([]sqlc.SpacePublicAdmissionRequest, error)
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
	return NewPublicInviteRepository(sqlc.New(pool), pool)
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
		if err != nil {
			return fmt.Errorf("rotate public invite: %w", err)
		}
		result = mapPublicInvite(row)
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) CreateArrival(ctx context.Context, arrival publicinvites.Arrival) (publicinvites.Arrival, error) {
	var result publicinvites.Arrival
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		params := sqlc.LockSpacePublicArrivalByIdempotencyParams{
			TenantID: uuid(arrival.TenantID), SpaceID: uuid(arrival.SpaceID), IdempotencyKey: arrival.IdempotencyKey,
		}
		existing, err := queries.LockSpacePublicArrivalByIdempotency(ctx, params)
		if err == nil {
			return resolveArrivalReplay(existing, arrival, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock public arrival replay: %w", err)
		}

		invite, err := queries.LockSpacePublicInviteByHandle(ctx, arrival.InviteHandle)
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrInviteUnavailable
		}
		if err != nil {
			return fmt.Errorf("lock public invite for arrival: %w", err)
		}
		if !invite.TenantID.Valid || !invite.SpaceID.Valid ||
			utilities.IDFromBytes(invite.TenantID.Bytes) != arrival.TenantID ||
			utilities.IDFromBytes(invite.SpaceID.Bytes) != arrival.SpaceID ||
			!invite.Enabled || invite.Generation != int64(arrival.InviteGeneration) ||
			invite.StateEpoch != int64(arrival.InviteStateEpoch) {
			return publicinvites.ErrInviteUnavailable
		}

		row, err := queries.CreateSpacePublicArrival(ctx, sqlc.CreateSpacePublicArrivalParams{
			ArrivalHandle:          uuid(arrival.ArrivalHandle),
			TenantID:               uuid(arrival.TenantID),
			SpaceID:                uuid(arrival.SpaceID),
			InviteHandle:           append([]byte(nil), arrival.InviteHandle...),
			InviteGeneration:       int64(arrival.InviteGeneration),
			InviteStateEpoch:       int64(arrival.InviteStateEpoch),
			IdentityMode:           string(arrival.IdentityMode),
			DisplayName:            arrival.DisplayName,
			GuestCredentialHash:    append([]byte(nil), arrival.GuestCredentialHash...),
			AccountID:              uuid(arrival.AccountID),
			CredentialFamily:       textValue(arrival.CredentialFamily),
			Provider:               textValue(arrival.Provider),
			ProviderSubject:        textValue(arrival.ProviderSubject),
			IdempotencyKey:         arrival.IdempotencyKey,
			IdempotencyFingerprint: append([]byte(nil), arrival.IdempotencyFingerprint[:]...),
			State:                  string(arrival.State),
			ExpiresAt:              timestamptz(&arrival.ExpiresAt),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			existing, replayErr := queries.LockSpacePublicArrivalByIdempotency(ctx, params)
			if errors.Is(replayErr, pgx.ErrNoRows) {
				return publicinvites.ErrIdempotencyConflict
			}
			if replayErr != nil {
				return fmt.Errorf("get public arrival replay: %w", replayErr)
			}
			return resolveArrivalReplay(existing, arrival, &result)
		}
		if err != nil {
			if uniqueViolation(err) {
				return publicinvites.ErrIdempotencyConflict
			}
			return fmt.Errorf("create public arrival: %w", err)
		}
		result = mapPublicArrival(row)
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) GetArrival(ctx context.Context, arrivalHandle utilities.ID) (publicinvites.Arrival, error) {
	row, err := r.queries.GetSpacePublicArrival(ctx, uuid(arrivalHandle))
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.Arrival{}, publicinvites.ErrArrivalNotFound
	}
	if err != nil {
		return publicinvites.Arrival{}, fmt.Errorf("get public arrival: %w", err)
	}
	return mapPublicArrival(row), nil
}

func (r PublicInviteRepository) GetArrivalForCredential(ctx context.Context, arrivalHandle utilities.ID, credentialHash []byte) (publicinvites.Arrival, error) {
	row, err := r.queries.GetSpacePublicArrivalForCredential(ctx, sqlc.GetSpacePublicArrivalForCredentialParams{
		ArrivalHandle: uuid(arrivalHandle), GuestCredentialHash: append([]byte(nil), credentialHash...),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.Arrival{}, publicinvites.ErrArrivalNotFound
	}
	if err != nil {
		return publicinvites.Arrival{}, fmt.Errorf("get public arrival for credential: %w", err)
	}
	return mapPublicArrival(row), nil
}

func (r PublicInviteRepository) GetArrivalByIdempotency(ctx context.Context, tenantID, spaceID utilities.ID, key string) (publicinvites.Arrival, error) {
	row, err := r.queries.GetSpacePublicArrivalByIdempotency(ctx, sqlc.GetSpacePublicArrivalByIdempotencyParams{
		TenantID: uuid(tenantID), SpaceID: uuid(spaceID), IdempotencyKey: key,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.Arrival{}, publicinvites.ErrArrivalNotFound
	}
	if err != nil {
		return publicinvites.Arrival{}, fmt.Errorf("get public arrival by idempotency: %w", err)
	}
	return mapPublicArrival(row), nil
}

func (r PublicInviteRepository) UpdateArrivalState(ctx context.Context, input publicinvites.UpdateArrivalStateInput) (publicinvites.Arrival, error) {
	if !validPublicArrivalState(input.State) {
		return publicinvites.Arrival{}, publicinvites.ErrArrivalUnavailable
	}
	var result publicinvites.Arrival
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		current, err := queries.LockSpacePublicArrival(ctx, uuid(input.ArrivalHandle))
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrArrivalNotFound
		}
		if err != nil {
			return fmt.Errorf("lock public arrival state: %w", err)
		}
		if utilities.IDFromBytes(current.TenantID.Bytes) != input.TenantID {
			return publicinvites.ErrArrivalNotFound
		}
		if !matchesExpectedProviderBinding(current, input) {
			return publicinvites.ErrMediaProofRejected
		}
		if !arrivalTransitionAllowed(publicinvites.ArrivalState(current.State), input.State) {
			return publicinvites.ErrArrivalUnavailable
		}
		row, err := queries.UpdateSpacePublicArrivalState(ctx, sqlc.UpdateSpacePublicArrivalStateParams{
			State: stateString(input.State), TerminalReason: textValue(input.Reason), EpisodeID: uuid(input.EpisodeID),
			ParticipantID: uuid(input.ParticipantID), ParticipantGeneration: nullableInt8(input.ParticipantGeneration),
			Provider: textValue(input.Provider), ProviderSubject: textValue(input.ProviderSubject),
			TenantID: uuid(input.TenantID), ArrivalHandle: uuid(input.ArrivalHandle),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrArrivalNotFound
		}
		if err != nil {
			return fmt.Errorf("update public arrival state: %w", err)
		}
		result = mapPublicArrival(row)
		return nil
	})
	return result, err
}

func matchesExpectedProviderBinding(current sqlc.SpacePublicArrival, input publicinvites.UpdateArrivalStateInput) bool {
	return !input.MatchProviderBinding || (current.Provider.String == input.ExpectedProvider && current.ProviderSubject.String == input.ExpectedProviderSubject)
}

func (r PublicInviteRepository) CreateAdmissionRequest(ctx context.Context, request publicinvites.AdmissionRequest) (publicinvites.AdmissionRequest, error) {
	var result publicinvites.AdmissionRequest
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		arrival, err := queries.LockSpacePublicArrival(ctx, uuid(request.ArrivalHandle))
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrArrivalNotFound
		}
		if err != nil {
			return fmt.Errorf("lock public arrival for admission request: %w", err)
		}
		if publicinvites.ArrivalState(arrival.State) != publicinvites.ArrivalPending {
			return publicinvites.ErrAdmissionRequestTerminal
		}
		request.TenantID = utilities.IDFromBytes(arrival.TenantID.Bytes)
		request.SpaceID = utilities.IDFromBytes(arrival.SpaceID.Bytes)
		row, err := queries.CreateSpacePublicAdmissionRequest(ctx, sqlc.CreateSpacePublicAdmissionRequestParams{
			RequestHandle: uuid(request.RequestHandle), ArrivalHandle: uuid(request.ArrivalHandle),
			TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, DisplayName: request.DisplayName,
			RequestedAt: timestamptz(&request.RequestedAt), ExpiresAt: timestamptz(&request.ExpiresAt),
		})
		if uniqueViolation(err) {
			return publicinvites.ErrInvalidAdmissionRequest
		}
		if err != nil {
			return fmt.Errorf("create public admission request: %w", err)
		}
		result = mapPublicAdmissionRequest(row)
		if result.ArrivalHandle != request.ArrivalHandle || result.TenantID != request.TenantID || result.SpaceID != request.SpaceID || result.DisplayName != request.DisplayName {
			return publicinvites.ErrIdempotencyConflict
		}
		if result.State != publicinvites.AdmissionRequestPending && result.State != publicinvites.AdmissionRequestApproved {
			return publicinvites.ErrAdmissionRequestTerminal
		}
		return nil
	})
	return result, err
}

func (r PublicInviteRepository) GetAdmissionRequest(ctx context.Context, tenantID, spaceID, requestHandle utilities.ID) (publicinvites.AdmissionRequest, error) {
	row, err := r.queries.GetSpacePublicAdmissionRequest(ctx, sqlc.GetSpacePublicAdmissionRequestParams{
		TenantID: uuid(tenantID), SpaceID: uuid(spaceID), RequestHandle: uuid(requestHandle),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.AdmissionRequest{}, publicinvites.ErrAdmissionRequestNotFound
	}
	if err != nil {
		return publicinvites.AdmissionRequest{}, fmt.Errorf("get public admission request: %w", err)
	}
	return mapPublicAdmissionRequest(row), nil
}

func (r PublicInviteRepository) ListAdmissionRequests(ctx context.Context, tenantID, spaceID utilities.ID, state publicinvites.AdmissionRequestState, pageSize int32) ([]publicinvites.AdmissionRequest, error) {
	rows, err := r.queries.ListPendingSpacePublicAdmissionRequests(ctx, sqlc.ListPendingSpacePublicAdmissionRequestsParams{
		TenantID: uuid(tenantID), SpaceID: uuid(spaceID), StateSet: state != "", State: string(state), PageSize: pageSize,
	})
	if err != nil {
		return nil, fmt.Errorf("list public admission requests: %w", err)
	}
	result := make([]publicinvites.AdmissionRequest, 0, len(rows))
	for _, row := range rows {
		result = append(result, mapPublicAdmissionRequest(row))
	}
	return result, nil
}

func (r PublicInviteRepository) DecideAdmissionRequest(ctx context.Context, input publicinvites.DecideAdmissionRequestInput) (publicinvites.AdmissionRequest, publicinvites.Arrival, error) {
	if input.Decision != publicinvites.DecisionApprove && input.Decision != publicinvites.DecisionDeny {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, publicinvites.ErrInvalidAdmissionDecision
	}
	var requestResult publicinvites.AdmissionRequest
	var arrivalResult publicinvites.Arrival
	var outcomeErr error
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		request, err := queries.LockSpacePublicAdmissionRequest(ctx, sqlc.LockSpacePublicAdmissionRequestParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrAdmissionRequestNotFound
		}
		if err != nil {
			return fmt.Errorf("lock public admission request: %w", err)
		}
		arrival, err := queries.LockSpacePublicArrival(ctx, request.ArrivalHandle)
		if errors.Is(err, pgx.ErrNoRows) {
			return publicinvites.ErrArrivalNotFound
		}
		if err != nil {
			return fmt.Errorf("lock public arrival for admission decision: %w", err)
		}
		if !arrival.TenantID.Valid || !arrival.SpaceID.Valid || arrival.TenantID != request.TenantID || arrival.SpaceID != request.SpaceID {
			return publicinvites.ErrAdmissionRequestNotFound
		}
		requestState := publicinvites.AdmissionRequestState(request.State)
		if requestState != publicinvites.AdmissionRequestPending {
			savedKey := publicInviteNullableString(request.DecisionRequestKey)
			if input.RequestKey != "" && savedKey == input.RequestKey {
				if (requestState == publicinvites.AdmissionRequestApproved && input.Decision == publicinvites.DecisionApprove) ||
					(requestState == publicinvites.AdmissionRequestDenied && input.Decision == publicinvites.DecisionDeny) {
					requestResult, arrivalResult = mapPublicAdmissionRequest(request), mapPublicArrival(arrival)
					return nil
				}
				if requestState == publicinvites.AdmissionRequestApproved || requestState == publicinvites.AdmissionRequestDenied {
					return publicinvites.ErrIdempotencyConflict
				}
			}
			return publicinvites.ErrAdmissionRequestTerminal
		}
		if publicinvites.ArrivalState(arrival.State) != publicinvites.ArrivalPending {
			updatedRequest, updateErr := queries.UpdateSpacePublicAdmissionRequest(ctx, sqlc.UpdateSpacePublicAdmissionRequestParams{
				State: string(publicinvites.AdmissionRequestInvalidated), DecidedBy: uuid(input.ActorID),
				DecisionRequestKey: textValue(input.RequestKey),
				TenantID:           uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle),
			})
			if updateErr != nil {
				return fmt.Errorf("invalidate terminal public admission request: %w", updateErr)
			}
			requestResult, arrivalResult = mapPublicAdmissionRequest(updatedRequest), mapPublicArrival(arrival)
			outcomeErr = publicinvites.ErrAdmissionRequestTerminal
			return nil
		}

		now := time.Now().UTC()
		if (request.ExpiresAt.Valid && !request.ExpiresAt.Time.After(now)) || (arrival.ExpiresAt.Valid && !arrival.ExpiresAt.Time.After(now)) {
			updatedRequest, updateErr := queries.UpdateSpacePublicAdmissionRequest(ctx, sqlc.UpdateSpacePublicAdmissionRequestParams{
				State: string(publicinvites.AdmissionRequestExpired), DecidedBy: uuid(input.ActorID),
				DecisionRequestKey: textValue(input.RequestKey),
				TenantID:           uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle),
			})
			if updateErr != nil {
				return fmt.Errorf("expire public admission request: %w", updateErr)
			}
			updatedArrival, updateErr := queries.UpdateSpacePublicArrivalState(ctx, sqlc.UpdateSpacePublicArrivalStateParams{
				State: string(publicinvites.ArrivalUnavailable), TerminalReason: textValue("admission_request_expired"),
				TenantID: uuid(input.TenantID), ArrivalHandle: request.ArrivalHandle,
			})
			if updateErr != nil {
				return fmt.Errorf("tombstone expired public arrival: %w", updateErr)
			}
			requestResult, arrivalResult = mapPublicAdmissionRequest(updatedRequest), mapPublicArrival(updatedArrival)
			outcomeErr = publicinvites.ErrAdmissionRequestTerminal
			return nil
		}

		requestState = publicinvites.AdmissionRequestApproved
		if input.Decision == publicinvites.DecisionDeny {
			requestState = publicinvites.AdmissionRequestDenied
		}
		updatedRequest, err := queries.UpdateSpacePublicAdmissionRequest(ctx, sqlc.UpdateSpacePublicAdmissionRequestParams{
			State: string(requestState), DecidedBy: uuid(input.ActorID), TenantID: uuid(input.TenantID),
			DecisionRequestKey: textValue(input.RequestKey),
			SpaceID:            uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle),
		})
		if err != nil {
			return fmt.Errorf("decide public admission request: %w", err)
		}
		requestResult = mapPublicAdmissionRequest(updatedRequest)
		if input.Decision == publicinvites.DecisionApprove {
			// Approval only authorizes the runtime to grant access. The arrival
			// stays pending until the runtime persists its participant binding.
			arrivalResult = mapPublicArrival(arrival)
			return nil
		}
		updatedArrival, err := queries.UpdateSpacePublicArrivalState(ctx, sqlc.UpdateSpacePublicArrivalStateParams{
			State: string(publicinvites.ArrivalRejected), TerminalReason: textValue("admission_denied"), TenantID: uuid(input.TenantID), ArrivalHandle: request.ArrivalHandle,
		})
		if err != nil {
			return fmt.Errorf("apply public admission decision: %w", err)
		}
		arrivalResult = mapPublicArrival(updatedArrival)
		return nil
	})
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	return requestResult, arrivalResult, outcomeErr
}

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

func resolveArrivalReplay(row sqlc.SpacePublicArrival, requested publicinvites.Arrival, result *publicinvites.Arrival) error {
	if !bytes.Equal(row.IdempotencyFingerprint, requested.IdempotencyFingerprint[:]) {
		return publicinvites.ErrIdempotencyConflict
	}
	*result = mapPublicArrival(row)
	return nil
}

func arrivalTransitionAllowed(current, next publicinvites.ArrivalState) bool {
	if current == next {
		return true
	}
	if current == publicinvites.ArrivalPending {
		return next == publicinvites.ArrivalAdmitted || next == publicinvites.ArrivalRejected || next == publicinvites.ArrivalLeft || next == publicinvites.ArrivalUnavailable
	}
	return current == publicinvites.ArrivalAdmitted && (next == publicinvites.ArrivalLeft || next == publicinvites.ArrivalUnavailable)
}

func validPublicArrivalState(state publicinvites.ArrivalState) bool {
	switch state {
	case publicinvites.ArrivalPending, publicinvites.ArrivalAdmitted, publicinvites.ArrivalRejected, publicinvites.ArrivalLeft, publicinvites.ArrivalUnavailable:
		return true
	default:
		return false
	}
}

func mapPublicInvite(row sqlc.SpacePublicInvite) publicinvites.Invite {
	return publicinvites.Invite{
		TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), Handle: append([]byte(nil), row.Handle...),
		Generation: uint64(row.Generation), StateEpoch: uint64(row.StateEpoch), Enabled: row.Enabled, PublicRole: row.PublicRole,
		AdmissionMode: publicinvites.AdmissionMode(row.AdmissionMode), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt),
		RotatedAt: timestamp(row.RotatedAt), DisabledAt: nullableTimestamp(row.DisabledAt), LastActorID: nullableID(row.LastActorID),
	}
}

func mapPublicArrival(row sqlc.SpacePublicArrival) publicinvites.Arrival {
	var fingerprint [32]byte
	copy(fingerprint[:], row.IdempotencyFingerprint)
	var participantGeneration int64
	if row.ParticipantGeneration.Valid {
		participantGeneration = row.ParticipantGeneration.Int64
	}
	return publicinvites.Arrival{
		ArrivalHandle: utilities.IDFromBytes(row.ArrivalHandle.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes),
		InviteHandle: append([]byte(nil), row.InviteHandle...), InviteGeneration: uint64(row.InviteGeneration), InviteStateEpoch: uint64(row.InviteStateEpoch), IdentityMode: publicinvites.IdentityMode(row.IdentityMode), DisplayName: row.DisplayName,
		GuestCredentialHash: append([]byte(nil), row.GuestCredentialHash...), AccountID: nullableID(row.AccountID), CredentialFamily: publicInviteNullableString(row.CredentialFamily), IdempotencyKey: row.IdempotencyKey,
		IdempotencyFingerprint: fingerprint, State: publicinvites.ArrivalState(row.State), EpisodeID: nullableID(row.EpisodeID), ParticipantID: nullableID(row.ParticipantID), ParticipantGeneration: participantGeneration,
		Provider: publicInviteNullableString(row.Provider), ProviderSubject: publicInviteNullableString(row.ProviderSubject),
		ExpiresAt: timestamp(row.ExpiresAt), TerminalReason: publicInviteNullableString(row.TerminalReason), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt), TerminalAt: nullableTimestamp(row.TerminalAt),
	}
}

func mapPublicAdmissionRequest(row sqlc.SpacePublicAdmissionRequest) publicinvites.AdmissionRequest {
	return publicinvites.AdmissionRequest{
		RequestHandle: utilities.IDFromBytes(row.RequestHandle.Bytes), ArrivalHandle: utilities.IDFromBytes(row.ArrivalHandle.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), DisplayName: row.DisplayName, State: publicinvites.AdmissionRequestState(row.State), RequestedAt: timestamp(row.RequestedAt),
		ExpiresAt: timestamp(row.ExpiresAt), DecidedAt: nullableTimestamp(row.DecidedAt), DecidedBy: nullableID(row.DecidedBy),
	}
}

func mapAutoLifecycle(row sqlc.AutoSpaceLifecycle) publicinvites.AutoLifecycle {
	return publicinvites.AutoLifecycle{
		TenantID: utilities.IDFromBytes(row.TenantID.Bytes), SpaceID: utilities.IDFromBytes(row.SpaceID.Bytes), DeadlineAt: timestamp(row.DeadlineAt), CreatorArrivalHandle: nullableID(row.CreatorArrivalHandle),
		State: publicinvites.AutoLifecycleState(row.State), NextRetryAt: nullableTimestamp(row.NextRetryAt), RetryCount: row.RetryCount, LastErrorFamily: publicInviteNullableString(row.LastErrorFamily),
		ArchiveCompletedAt: nullableTimestamp(row.ArchiveCompletedAt), JourneyID: nullableID(row.JourneyID), CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt),
	}
}

func stateString(state publicinvites.ArrivalState) string { return string(state) }

func nullableInt8(value int64) pgtype.Int8 {
	if value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

func textValue(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func publicInviteNullableString(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func nullableErrorFamily(value string) pgtype.Text { return textValue(value) }
