package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Public admission records only associate an authenticated arrival with the
// canonical Episode request. Sync owns admission, denial, and expiry.
func (r PublicInviteRepository) CreateAdmissionRequest(ctx context.Context, request publicinvites.AdmissionRequest) (publicinvites.AdmissionRequest, error) {
	arrival, err := r.GetArrival(ctx, request.ArrivalHandle)
	if err != nil {
		return publicinvites.AdmissionRequest{}, err
	}
	var result publicinvites.AdmissionRequest
	var commitMetric webhookCommitMetric
	err = r.lifecycle.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		if r.lifecycle.tenantLimits.AppliesTo(arrival.TenantID) && r.lifecycle.tenantLimits.MaxLiveEpisodes > 0 {
			if _, err := queries.LockTenantMediaLimits(ctx, uuid(arrival.TenantID)); err != nil {
				return fmt.Errorf("lock public admission tenant limits: %w", err)
			}
		}
		space, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(arrival.TenantID), ID: uuid(arrival.SpaceID)})
		if err != nil {
			return fmt.Errorf("lock public admission Space: %w", err)
		}
		if space.ArchivedAt.Valid {
			return publicinvites.ErrInviteUnavailable
		}
		episode, _, metric, err := r.lifecycle.ensurePublicLiveEpisode(ctx, queries, tx, arrival.TenantID, arrival.SpaceID, space)
		if err != nil {
			return err
		}
		commitMetric = metric
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}
		current, err := queries.LockSpacePublicArrival(ctx, uuid(arrival.ArrivalHandle))
		if err != nil {
			return fmt.Errorf("lock public admission arrival: %w", err)
		}
		if publicinvites.ArrivalState(current.State) != publicinvites.ArrivalPending {
			return publicinvites.ErrAdmissionRequestTerminal
		}
		existing, err := queries.GetSpacePublicAdmissionRequestForArrival(ctx, sqlc.GetSpacePublicAdmissionRequestForArrivalParams{TenantID: current.TenantID, SpaceID: current.SpaceID, ArrivalHandle: current.ArrivalHandle})
		if err == nil {
			result = mapPublicAdmissionRequest(sqlc.SpacePublicAdmissionRequest(existing))
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		config, err := episodeConfig(episode.ConfigSnapshot)
		if err != nil {
			return err
		}
		mode, err := configAdmissionMode(config.AdmissionPolicy)
		if err != nil {
			return err
		}
		if mode != "knock" {
			return publicinvites.ErrInviteUnavailable
		}
		capabilities, ok := config.Roles[publicinvites.PublicRoleCollaborator]
		if !ok {
			return episodes.ErrInvalidRole
		}
		participantID, err := utilities.NewID()
		if err != nil {
			return err
		}
		input := episodes.AdmitParticipantInput{
			TenantID: arrival.TenantID, SpaceID: arrival.SpaceID, EpisodeID: utilities.IDFromBytes(episode.ID.Bytes),
			ParticipantID: participantID, Name: arrival.DisplayName, Role: publicinvites.PublicRoleCollaborator,
			Request: episodes.Request{Key: arrival.IdempotencyKey, Fingerprint: arrival.IdempotencyFingerprint},
		}
		var admission episodes.Admission
		if err := createKnockAdmission(ctx, queries, tx, input, episode, capabilities, episodes.ParticipantJoinedPayload(participantID, arrival.DisplayName, input.Role), &admission); err != nil {
			return err
		}
		row, err := queries.CreateSpacePublicAdmissionRequest(ctx, sqlc.CreateSpacePublicAdmissionRequestParams{
			RequestHandle: uuid(admission.AdmissionRequest.ID), ArrivalHandle: current.ArrivalHandle,
			TenantID: current.TenantID, SpaceID: current.SpaceID, DisplayName: arrival.DisplayName,
			RequestedAt: timestamptz(&request.RequestedAt), ExpiresAt: timestamptz(&admission.AdmissionRequest.ExpiresAt),
		})
		if err != nil {
			return fmt.Errorf("associate public arrival with Episode admission: %w", err)
		}
		result = mapPublicAdmissionRequest(row)
		return nil
	})
	if err == nil {
		commitMetric.Record(ctx)
	}
	return result, err
}

func (r PublicInviteRepository) GetAdmissionRequestForArrival(ctx context.Context, arrival publicinvites.Arrival) (publicinvites.AdmissionRequest, error) {
	row, err := r.queries.GetSpacePublicAdmissionRequestForArrival(ctx, sqlc.GetSpacePublicAdmissionRequestForArrivalParams{TenantID: uuid(arrival.TenantID), SpaceID: uuid(arrival.SpaceID), ArrivalHandle: uuid(arrival.ArrivalHandle)})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.AdmissionRequest{}, publicinvites.ErrAdmissionRequestNotFound
	}
	if err != nil {
		return publicinvites.AdmissionRequest{}, fmt.Errorf("get public arrival admission: %w", err)
	}
	return r.withAdmissionBinding(ctx, mapPublicAdmissionRequest(sqlc.SpacePublicAdmissionRequest(row)))
}

func (r PublicInviteRepository) withAdmissionBinding(ctx context.Context, request publicinvites.AdmissionRequest) (publicinvites.AdmissionRequest, error) {
	binding, err := r.queries.GetPublicAdmissionBinding(ctx, sqlc.GetPublicAdmissionBindingParams{TenantID: uuid(request.TenantID), SpaceID: uuid(request.SpaceID), RequestHandle: uuid(request.RequestHandle)})
	if errors.Is(err, pgx.ErrNoRows) {
		return request, nil // A request created before canonical admission was wired.
	}
	if err != nil {
		return publicinvites.AdmissionRequest{}, fmt.Errorf("get public admission binding: %w", err)
	}
	request.Binding = &publicinvites.AdmissionBinding{EpisodeID: utilities.IDFromBytes(binding.EpisodeID.Bytes), ParticipantID: utilities.IDFromBytes(binding.ParticipantID.Bytes), ParticipantGeneration: binding.Generation}
	return request, nil
}

func (r PublicInviteRepository) DecideAdmissionRequest(ctx context.Context, input publicinvites.DecideAdmissionRequestInput) (publicinvites.AdmissionRequest, publicinvites.Arrival, error) {
	request, err := r.GetAdmissionRequest(ctx, input.TenantID, input.SpaceID, input.RequestHandle)
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	arrival, err := r.GetArrival(ctx, request.ArrivalHandle)
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	var legacy bool
	err = r.lifecycle.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		// Match Sync's lock order: control, Episode, admission request.
		live, err := queries.GetPublicEpisodeAdmission(ctx, sqlc.GetPublicEpisodeAdmissionParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle)})
		if errors.Is(err, pgx.ErrNoRows) {
			legacy = true
			return nil
		}
		if err != nil {
			return err
		}
		episodeID := utilities.IDFromBytes(live.EpisodeID.Bytes)
		if _, err := lockLifecycleControlRow(ctx, queries, input.TenantID, input.SpaceID, episodeID); err != nil {
			return err
		}
		episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, episodeID)
		if err != nil {
			return err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return publicinvites.ErrAdmissionRequestTerminal
		}
		live, err = queries.LockPublicEpisodeAdmission(ctx, sqlc.LockPublicEpisodeAdmissionParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle)})
		if err != nil {
			return err
		}
		if live.Status != "pending" {
			if (live.Status == "admitted" && input.Decision == publicinvites.DecisionApprove) || (live.Status == "denied" && input.Decision == publicinvites.DecisionDeny) {
				return nil
			}
			return publicinvites.ErrAdmissionRequestTerminal
		}
		currentArrival, err := queries.LockSpacePublicArrival(ctx, uuid(arrival.ArrivalHandle))
		if err != nil {
			return err
		}
		if publicinvites.ArrivalState(currentArrival.State) != publicinvites.ArrivalPending || !currentArrival.ExpiresAt.Time.After(time.Now()) {
			return publicinvites.ErrAdmissionRequestTerminal
		}
		operationName := "admit_participant"
		if input.Decision == publicinvites.DecisionDeny {
			operationName = "deny_admission"
		}
		if live.DecisionExternalOperationID.Valid {
			name, err := queries.GetAdmissionDecisionOperationName(ctx, sqlc.GetAdmissionDecisionOperationNameParams{TenantID: live.TenantID, EpisodeID: live.EpisodeID, ExternalOperationID: live.DecisionExternalOperationID})
			if err != nil {
				return err
			}
			if name != operationName {
				return publicinvites.ErrAdmissionRequestTerminal
			}
			return nil
		}
		if !live.ExpiresAt.Time.After(time.Now()) {
			return publicinvites.ErrAdmissionRequestTerminal
		}
		payload, err := json.Marshal(struct {
			ID string `json:"admissionRequestId"`
		}{input.RequestHandle.String()})
		if err != nil {
			return err
		}
		key := input.RequestKey
		if key == "" {
			key = input.RequestHandle.String()
		}
		operation, err := createTenantExternalOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: episodeID, OperationName: operationName,
			Request: episodes.Request{Key: key, Fingerprint: sha256.Sum256(payload)}, Payload: payload,
			JourneyName: "participant.public_admission_decided",
		})
		if err != nil {
			return err
		}
		reserved, err := queries.ReserveEpisodeAdmissionDecision(ctx, sqlc.ReserveEpisodeAdmissionDecisionParams{TenantID: live.TenantID, SpaceID: live.SpaceID, EpisodeID: live.EpisodeID, AdmissionRequestID: live.AdmissionRequestID, ExternalOperationID: operation.ExternalOperationID})
		if err != nil {
			return err
		}
		if reserved != 1 {
			return publicinvites.ErrAdmissionRequestTerminal
		}
		return nil
	})
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	if legacy {
		return r.decideLegacyAdmissionRequest(ctx, input)
	}
	return request, arrival, nil
}
