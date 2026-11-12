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
	decision := &legacyAdmissionDecision{input: input}
	err := r.mutate(ctx, func(queries publicInviteQuerier) error {
		decision.queries = queries
		return decision.run(ctx)
	})
	if err != nil {
		return publicinvites.AdmissionRequest{}, publicinvites.Arrival{}, err
	}
	return decision.requestResult, decision.arrivalResult, decision.outcomeErr
}

// legacyAdmissionDecision decides a public admission request that has no canonical Episode admission.
// outcomeErr is a terminal outcome that still commits its writes.
type legacyAdmissionDecision struct {
	queries       publicInviteQuerier
	input         publicinvites.DecideAdmissionRequestInput
	request       sqlc.SpacePublicAdmissionRequest
	arrival       sqlc.SpacePublicArrival
	requestResult publicinvites.AdmissionRequest
	arrivalResult publicinvites.Arrival
	outcomeErr    error
}

func (d *legacyAdmissionDecision) run(ctx context.Context) error {
	input := d.input
	request, err := d.queries.LockSpacePublicAdmissionRequest(ctx, sqlc.LockSpacePublicAdmissionRequestParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.ErrAdmissionRequestNotFound
	}
	if err != nil {
		return fmt.Errorf("lock public admission request: %w", err)
	}
	arrival, err := d.queries.LockSpacePublicArrival(ctx, request.ArrivalHandle)
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.ErrArrivalNotFound
	}
	if err != nil {
		return fmt.Errorf("lock public arrival for admission decision: %w", err)
	}
	if !arrival.TenantID.Valid || !arrival.SpaceID.Valid || arrival.TenantID != request.TenantID || arrival.SpaceID != request.SpaceID {
		return publicinvites.ErrAdmissionRequestNotFound
	}
	d.request, d.arrival = request, arrival
	if state := publicinvites.AdmissionRequestState(request.State); state != publicinvites.AdmissionRequestPending {
		return d.replayDecided(state)
	}
	if publicinvites.ArrivalState(arrival.State) != publicinvites.ArrivalPending {
		return d.invalidate(ctx)
	}
	now := time.Now().UTC()
	if (request.ExpiresAt.Valid && !request.ExpiresAt.Time.After(now)) || (arrival.ExpiresAt.Valid && !arrival.ExpiresAt.Time.After(now)) {
		return d.expire(ctx)
	}
	return d.decide(ctx)
}

// replayDecided answers a request that is no longer pending: the same decision under the same key
// replays, any other attempt is a conflict or terminal.
func (d *legacyAdmissionDecision) replayDecided(state publicinvites.AdmissionRequestState) error {
	input := d.input
	if input.RequestKey != "" && publicInviteNullableString(d.request.DecisionRequestKey) == input.RequestKey {
		if (state == publicinvites.AdmissionRequestApproved && input.Decision == publicinvites.DecisionApprove) ||
			(state == publicinvites.AdmissionRequestDenied && input.Decision == publicinvites.DecisionDeny) {
			d.requestResult, d.arrivalResult = mapPublicAdmissionRequest(d.request), mapPublicArrival(d.arrival)
			return nil
		}
		if state == publicinvites.AdmissionRequestApproved || state == publicinvites.AdmissionRequestDenied {
			return publicinvites.ErrIdempotencyConflict
		}
	}
	return publicinvites.ErrAdmissionRequestTerminal
}

func (d *legacyAdmissionDecision) setRequestState(ctx context.Context, state publicinvites.AdmissionRequestState) (sqlc.SpacePublicAdmissionRequest, error) {
	input := d.input
	return d.queries.UpdateSpacePublicAdmissionRequest(ctx, sqlc.UpdateSpacePublicAdmissionRequestParams{
		State: string(state), DecidedBy: uuid(input.ActorID), DecisionRequestKey: textValue(input.RequestKey),
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestHandle: uuid(input.RequestHandle),
	})
}

func (d *legacyAdmissionDecision) setArrivalState(ctx context.Context, state publicinvites.ArrivalState, reason string) (sqlc.SpacePublicArrival, error) {
	return d.queries.UpdateSpacePublicArrivalState(ctx, sqlc.UpdateSpacePublicArrivalStateParams{
		State: string(state), TerminalReason: textValue(reason), TenantID: uuid(d.input.TenantID), ArrivalHandle: d.request.ArrivalHandle,
	})
}

// invalidate closes a pending request whose arrival has already left the pending state.
func (d *legacyAdmissionDecision) invalidate(ctx context.Context) error {
	updated, err := d.setRequestState(ctx, publicinvites.AdmissionRequestInvalidated)
	if err != nil {
		return fmt.Errorf("invalidate terminal public admission request: %w", err)
	}
	d.requestResult, d.arrivalResult = mapPublicAdmissionRequest(updated), mapPublicArrival(d.arrival)
	d.outcomeErr = publicinvites.ErrAdmissionRequestTerminal
	return nil
}

// expire closes a request, or an arrival, that ran past its lifetime.
func (d *legacyAdmissionDecision) expire(ctx context.Context) error {
	updatedRequest, err := d.setRequestState(ctx, publicinvites.AdmissionRequestExpired)
	if err != nil {
		return fmt.Errorf("expire public admission request: %w", err)
	}
	updatedArrival, err := d.setArrivalState(ctx, publicinvites.ArrivalUnavailable, "admission_request_expired")
	if err != nil {
		return fmt.Errorf("tombstone expired public arrival: %w", err)
	}
	d.requestResult, d.arrivalResult = mapPublicAdmissionRequest(updatedRequest), mapPublicArrival(updatedArrival)
	d.outcomeErr = publicinvites.ErrAdmissionRequestTerminal
	return nil
}

func (d *legacyAdmissionDecision) decide(ctx context.Context) error {
	state := publicinvites.AdmissionRequestApproved
	if d.input.Decision == publicinvites.DecisionDeny {
		state = publicinvites.AdmissionRequestDenied
	}
	updated, err := d.setRequestState(ctx, state)
	if err != nil {
		return fmt.Errorf("decide public admission request: %w", err)
	}
	d.requestResult = mapPublicAdmissionRequest(updated)
	if d.input.Decision == publicinvites.DecisionApprove {
		// Approval only authorizes the runtime to grant access. The arrival
		// stays pending until the runtime persists its participant binding.
		d.arrivalResult = mapPublicArrival(d.arrival)
		return nil
	}
	updatedArrival, err := d.setArrivalState(ctx, publicinvites.ArrivalRejected, "admission_denied")
	if err != nil {
		return fmt.Errorf("apply public admission decision: %w", err)
	}
	d.arrivalResult = mapPublicArrival(updatedArrival)
	return nil
}
