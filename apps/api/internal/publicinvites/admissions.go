package publicinvites

import (
	"context"
	"fmt"
	"strings"

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
