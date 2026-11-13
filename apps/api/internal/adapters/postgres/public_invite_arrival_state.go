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
