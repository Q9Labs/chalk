package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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

func resolveArrivalReplay(row sqlc.SpacePublicArrival, requested publicinvites.Arrival, result *publicinvites.Arrival) error {
	if !bytes.Equal(row.IdempotencyFingerprint, requested.IdempotencyFingerprint[:]) {
		return publicinvites.ErrIdempotencyConflict
	}
	*result = mapPublicArrival(row)
	return nil
}
