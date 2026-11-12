package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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
	return r.withAdmissionBinding(ctx, mapPublicAdmissionProjection(sqlc.ListPendingSpacePublicAdmissionRequestsRow(row)))
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
		result = append(result, mapPublicAdmissionProjection(row))
	}
	return result, nil
}

func (r PublicInviteRepository) decideLegacyAdmissionRequest(ctx context.Context, input publicinvites.DecideAdmissionRequestInput) (publicinvites.AdmissionRequest, publicinvites.Arrival, error) {
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
