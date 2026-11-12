package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
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

func (r PublicInviteRepository) UpdateArrivalState(ctx context.Context, input publicinvites.UpdateArrivalStateInput) (publicinvites.Arrival, error) {
	if !validPublicArrivalState(input.State) {
		return publicinvites.Arrival{}, publicinvites.ErrArrivalUnavailable
	}
	var result publicinvites.Arrival
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		collecting := input.RequirePending && input.State == publicinvites.ArrivalAdmitted
		var rows collectionRows
		if collecting {
			var err error
			if rows, err = lockCollectionRows(ctx, queries, input); err != nil {
				return err
			}
		}
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
		if input.RequirePending && current.State != string(publicinvites.ArrivalPending) {
			return publicinvites.ErrArrivalUnavailable
		}
		if collecting {
			if err := checkCollection(ctx, queries, input, rows, current); err != nil {
				return err
			}
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
		if current.State == string(publicinvites.ArrivalPending) && input.State == publicinvites.ArrivalUnavailable && input.Reason == "cancelled" {
			return recordAdmissionCancellation(ctx, queries, current)
		}
		return nil
	})
	return result, err
}

// collectionRows are the rows an admitted-arrival collection locks before the arrival itself.
type collectionRows struct {
	invite  sqlc.SpacePublicInvite
	space   sqlc.Space
	episode sqlc.Episode
}

// lockCollectionRows locks in the order admission decisions use: invite, Space, Episode, then (in the
// caller) arrival and (in checkCollection) participant. The immutable binding locates the rows.
func lockCollectionRows(ctx context.Context, queries publicInviteQuerier, input publicinvites.UpdateArrivalStateInput) (collectionRows, error) {
	binding, err := queries.GetSpacePublicArrival(ctx, uuid(input.ArrivalHandle))
	if errors.Is(err, pgx.ErrNoRows) {
		return collectionRows{}, publicinvites.ErrArrivalNotFound
	}
	if err != nil {
		return collectionRows{}, fmt.Errorf("read public collection binding: %w", err)
	}
	if utilities.IDFromBytes(binding.TenantID.Bytes) != input.TenantID {
		return collectionRows{}, publicinvites.ErrArrivalNotFound
	}
	invite, err := queries.LockSpacePublicInvite(ctx, sqlc.LockSpacePublicInviteParams{TenantID: binding.TenantID, SpaceID: binding.SpaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return collectionRows{}, publicinvites.ErrArrivalUnavailable
	}
	if err != nil {
		return collectionRows{}, fmt.Errorf("lock public collection invite: %w", err)
	}
	space, err := queries.LockTenantSpaceForAdmission(ctx, sqlc.LockTenantSpaceForAdmissionParams{TenantID: binding.TenantID, ID: binding.SpaceID})
	if errors.Is(err, pgx.ErrNoRows) {
		return collectionRows{}, publicinvites.ErrArrivalUnavailable
	}
	if err != nil {
		return collectionRows{}, fmt.Errorf("lock public collection Space: %w", err)
	}
	episode, err := queries.LockLifecycleEpisodeForUpdate(ctx, sqlc.LockLifecycleEpisodeForUpdateParams{TenantID: binding.TenantID, SpaceID: binding.SpaceID, EpisodeID: uuid(input.EpisodeID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return collectionRows{}, publicinvites.ErrArrivalUnavailable
	}
	if err != nil {
		return collectionRows{}, fmt.Errorf("lock public collection Episode: %w", err)
	}
	return collectionRows{invite: invite, space: space, episode: episode}, nil
}

// checkCollection confirms the locked arrival still has valid provenance and an active participant at
// the generation the caller names.
func checkCollection(ctx context.Context, queries publicInviteQuerier, input publicinvites.UpdateArrivalStateInput, rows collectionRows, current sqlc.SpacePublicArrival) error {
	valid, err := publicAdmissionProvenanceValid(rows.space, rows.invite, current, rows.episode, time.Now())
	if err != nil {
		return err
	}
	if !valid {
		return publicinvites.ErrArrivalUnavailable
	}
	participant, err := queries.LockLifecycleParticipantForUpdate(ctx, sqlc.LockLifecycleParticipantForUpdateParams{TenantID: current.TenantID, SpaceID: current.SpaceID, EpisodeID: uuid(input.EpisodeID), ParticipantID: uuid(input.ParticipantID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.ErrArrivalUnavailable
	}
	if err != nil {
		return fmt.Errorf("lock public collection participant: %w", err)
	}
	if participant.Status != episodes.ParticipantStatusActive || participant.Generation != input.ParticipantGeneration {
		return publicinvites.ErrArrivalUnavailable
	}
	return nil
}

func recordAdmissionCancellation(ctx context.Context, queries publicInviteQuerier, current sqlc.SpacePublicArrival) error {
	journey, err := lifecycleJourneyFromContext(ctx)
	if err != nil {
		return fmt.Errorf("create admission cancellation journey: %w", err)
	}
	if err := queries.RecordPublicAdmissionCancellation(ctx, sqlc.RecordPublicAdmissionCancellationParams{
		EventID: uuid(journey.ParentEventID), JourneyID: uuid(journey.JourneyID),
		TraceID: textValue(journey.TraceID), SpanID: textValue(journey.SpanID),
		TenantID: current.TenantID, SpaceID: current.SpaceID, ArrivalHandle: current.ArrivalHandle,
	}); err != nil {
		return fmt.Errorf("record admission cancellation journey: %w", err)
	}
	return nil
}

func publicAdmissionProvenanceValid(space sqlc.Space, invite sqlc.SpacePublicInvite, arrival sqlc.SpacePublicArrival, episode sqlc.Episode, now time.Time) (bool, error) {
	mode, err := configAdmissionMode(space.AdmissionPolicy)
	if err != nil {
		return false, err
	}
	if space.TenantID != arrival.TenantID || space.ID != arrival.SpaceID ||
		invite.TenantID != arrival.TenantID || invite.SpaceID != arrival.SpaceID ||
		episode.TenantID != arrival.TenantID || episode.SpaceID != arrival.SpaceID {
		return false, nil
	}
	return episode.Status == episodes.EpisodeStatusActive && !space.ArchivedAt.Valid && mode == "knock" && invite.Enabled &&
		arrival.State == string(publicinvites.ArrivalPending) && arrival.ExpiresAt.Time.After(now) &&
		bytes.Equal(invite.Handle, arrival.InviteHandle) && invite.Generation == arrival.InviteGeneration &&
		invite.StateEpoch == arrival.InviteStateEpoch, nil
}

func matchesExpectedProviderBinding(current sqlc.SpacePublicArrival, input publicinvites.UpdateArrivalStateInput) bool {
	return !input.MatchProviderBinding || (current.Provider.String == input.ExpectedProvider && current.ProviderSubject.String == input.ExpectedProviderSubject)
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
