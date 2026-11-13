package publicinvites

import (
	"context"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r Runtime) ListAdmissionRequests(ctx context.Context, input ListPublicAdmissionRequestsInput) (AdmissionRequestPage, error) {
	requests, err := r.service.ListAdmissionRequestsForSpace(ctx, input.TenantID, input.SpaceID, AdmissionRequestState(input.State), input.PageSize)
	if err != nil {
		return AdmissionRequestPage{}, err
	}
	return AdmissionRequestPage{Requests: requests}, nil
}

func (r Runtime) ApproveAdmissionRequest(ctx context.Context, input DecidePublicAdmissionRequestInput) (AdmissionRequest, error) {
	return r.decideAdmissionRequest(ctx, input, DecisionApprove)
}

func (r Runtime) DenyAdmissionRequest(ctx context.Context, input DecidePublicAdmissionRequestInput) (AdmissionRequest, error) {
	return r.decideAdmissionRequest(ctx, input, DecisionDeny)
}

func (r Runtime) decideAdmissionRequest(ctx context.Context, input DecidePublicAdmissionRequestInput, decision AdmissionDecision) (AdmissionRequest, error) {
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return AdmissionRequest{}, ErrInvalidRequestKey
		}
	}
	requestHandle, err := utilities.ParseID(strings.TrimSpace(input.RequestHandle))
	if err != nil {
		return AdmissionRequest{}, ErrAdmissionRequestNotFound
	}
	request, arrival, err := r.service.DecideAdmissionRequest(ctx, DecideAdmissionRequestInput{
		TenantID:      input.TenantID,
		SpaceID:       input.SpaceID,
		RequestHandle: requestHandle,
		Decision:      decision,
		ActorID:       input.ActorID,
		RequestKey:    input.RequestKey,
	})
	if err != nil {
		return AdmissionRequest{}, err
	}
	if request.Binding != nil || request.State == AdmissionRequestPending {
		// New requests use Sync's durable decision operation. The guest collects
		// access only after that operation commits the canonical admission.
		return request, nil
	}
	if decision == DecisionDeny {
		if request.State != AdmissionRequestDenied {
			return AdmissionRequest{}, ErrAdmissionRequestTerminal
		}
		return request, nil
	}
	switch arrival.State {
	case ArrivalAdmitted:
		return request, nil
	case ArrivalPending:
		if err := r.admitLegacyApproval(ctx, arrival); err != nil {
			return AdmissionRequest{}, err
		}
		return request, nil
	}
	return AdmissionRequest{}, ErrAdmissionRequestTerminal
}

// admitLegacyApproval admits the pending Arrival of a request approved before
// requests carried a durable Sync decision. Legacy approval allocates a seat,
// unlike canonical credential collection, so it rejects already-revoked
// requests before that allocation as well as at commit.
func (r Runtime) admitLegacyApproval(ctx context.Context, arrival Arrival) error {
	space, err := r.loadPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
	if err != nil {
		return err
	}
	valid, err := r.pendingGuestArrivalValid(ctx, arrival, space)
	if err != nil {
		return err
	}
	if !valid {
		if _, err := r.invalidatePendingArrival(ctx, arrival); err != nil {
			return err
		}
		return ErrInviteUnavailable
	}
	grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, RequireKnock: true, MediaClients: mediaplane.AllClientProviders()})
	if err != nil {
		return err
	}
	if err := validateAccessGrant(grant, arrival); err != nil {
		return err
	}
	if _, err := r.service.UpdateArrivalState(ctx, UpdateArrivalStateInput{
		TenantID:              arrival.TenantID,
		ArrivalHandle:         arrival.ArrivalHandle,
		State:                 ArrivalAdmitted,
		RequirePending:        true,
		EpisodeID:             grant.EpisodeID,
		ParticipantID:         grant.ParticipantID,
		ParticipantGeneration: grant.ParticipantGeneration,
		Provider:              grant.Provider,
		ProviderSubject:       grant.ProviderSubject,
	}); err != nil {
		_ = r.access.DiscardPublicAccess(ctx, grant)
		return err
	}
	return nil
}
