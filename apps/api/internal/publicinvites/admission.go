package publicinvites

import (
	"context"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (s Service) CreateAdmissionRequest(ctx context.Context, input CreateAdmissionRequestInput) (AdmissionRequest, error) {
	if input.ArrivalHandle.IsZero() {
		return AdmissionRequest{}, ErrInvalidAdmissionRequest
	}
	name := strings.TrimSpace(input.DisplayName)
	if err := validateDisplayName(name); err != nil {
		return AdmissionRequest{}, err
	}
	now := s.now()
	expiresAt := input.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = now.Add(AdmissionRequestLifetime)
	}
	if !expiresAt.After(now) || expiresAt.After(now.Add(AdmissionRequestLifetime)) {
		return AdmissionRequest{}, ErrInvalidAdmissionRequest
	}
	handle, err := utilities.NewID()
	if err != nil {
		return AdmissionRequest{}, fmt.Errorf("generate admission request handle: %w", err)
	}
	return s.repository.CreateAdmissionRequest(ctx, AdmissionRequest{
		RequestHandle: handle,
		ArrivalHandle: input.ArrivalHandle,
		DisplayName:   name,
		State:         AdmissionRequestPending,
		RequestedAt:   now,
		ExpiresAt:     expiresAt,
	}, input.MediaClients)
}

func (s Service) GetAdmissionRequest(ctx context.Context, tenantID, spaceID, requestHandle utilities.ID) (AdmissionRequest, error) {
	if err := validateIDs(tenantID, spaceID); err != nil || requestHandle.IsZero() {
		return AdmissionRequest{}, ErrAdmissionRequestNotFound
	}
	return s.repository.GetAdmissionRequest(ctx, tenantID, spaceID, requestHandle)
}

func (s Service) ListAdmissionRequestsForSpace(ctx context.Context, tenantID, spaceID utilities.ID, state AdmissionRequestState, pageSize int32) ([]AdmissionRequest, error) {
	if err := validateIDs(tenantID, spaceID); err != nil {
		return nil, err
	}
	if state != "" && state != AdmissionRequestPending {
		return nil, ErrInvalidAdmissionRequest
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 50
	}
	return s.repository.ListAdmissionRequests(ctx, tenantID, spaceID, state, pageSize)
}

// ListAdmissionRequests preserves the low-level persistence-facing shape for
// callers that do not need the Runtime page wrapper.
func (s Service) ListAdmissionRequests(ctx context.Context, tenantID, spaceID utilities.ID, state AdmissionRequestState, pageSize int32) ([]AdmissionRequest, error) {
	return s.ListAdmissionRequestsForSpace(ctx, tenantID, spaceID, state, pageSize)
}

func (s Service) DecideAdmissionRequest(ctx context.Context, input DecideAdmissionRequestInput) (AdmissionRequest, Arrival, error) {
	if err := validateIDs(input.TenantID, input.SpaceID); err != nil || input.RequestHandle.IsZero() {
		return AdmissionRequest{}, Arrival{}, ErrAdmissionRequestNotFound
	}
	if !input.Decision.valid() {
		return AdmissionRequest{}, Arrival{}, ErrInvalidAdmissionDecision
	}
	if input.RequestKey != "" {
		if err := validateIdempotencyKey(input.RequestKey); err != nil {
			return AdmissionRequest{}, Arrival{}, ErrInvalidRequestKey
		}
	}
	return s.repository.DecideAdmissionRequest(ctx, input)
}

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
	if arrival.State == ArrivalAdmitted {
		return request, nil
	}
	if arrival.State != ArrivalPending {
		return AdmissionRequest{}, ErrAdmissionRequestTerminal
	}
	if err := r.admitLegacyKnock(ctx, arrival); err != nil {
		return AdmissionRequest{}, err
	}
	return request, nil
}

func (r Runtime) admitLegacyKnock(ctx context.Context, arrival Arrival) error {
	// Legacy approval allocates a seat, unlike canonical credential collection.
	// Reject already-revoked requests before that allocation as well as at commit.
	space, err := r.space.GetPublicSpace(ctx, arrival.TenantID, arrival.SpaceID)
	if err != nil {
		return err
	}
	if space.TenantID != arrival.TenantID || space.SpaceID != arrival.SpaceID {
		return ErrInviteUnavailable
	}
	valid, validationErr := r.pendingGuestArrivalValid(ctx, arrival, space)
	if validationErr != nil {
		return validationErr
	}
	if !valid {
		if _, updateErr := r.invalidatePendingArrival(ctx, arrival); updateErr != nil {
			return updateErr
		}
		return ErrInviteUnavailable
	}
	grant, err := r.access.GrantPublicAccess(ctx, PublicAccessInput{Arrival: arrival, RequireAdmission: AdmissionKnock, MediaClients: mediaplane.AllClientProviders()})
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
		RequireAdmission:      AdmissionKnock,
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
