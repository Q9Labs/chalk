package tenants

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Service struct {
	repository TenantRepository
	// publicMediaPlane says which default planes a Tenant owner may choose for the Tenant.
	// Any other known plane is an operator decision.
	publicMediaPlane func(string) bool
	knownMediaPlane  func(string) bool
}

func NewService(repository TenantRepository) Service {
	return Service{repository: repository}
}

// WithMediaPlanes sets which default planes CreateTenant and UpdateTenant accept besides
// null, and which strings name a plane at all. Without it they accept no plane.
func (s Service) WithMediaPlanes(public, known func(string) bool) Service {
	s.publicMediaPlane, s.knownMediaPlane = public, known
	return s
}

// SetDefaultMediaPlane writes the Tenant's default plane with operator authority, or
// clears it with nil. No public route reaches it. The caller checks that the Tenant can
// serve the plane.
func (s Service) SetDefaultMediaPlane(ctx context.Context, id utilities.ID, plane *string) (Tenant, error) {
	if id.IsZero() {
		return Tenant{}, ErrInvalidTenantID
	}
	return s.repository.UpdateTenant(ctx, id, UpdateTenantInput{DefaultMediaPlane: utilities.OptionalString{Set: true, Value: plane}, DefaultMediaPlaneApproved: plane != nil})
}

func (s Service) CreateTenant(ctx context.Context, input CreateTenantInput) (Tenant, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Tenant{}, err
	}

	input.ID = id
	if input.CreatedByServiceID != nil && !ValidServiceID(*input.CreatedByServiceID) {
		return Tenant{}, ErrInvalidTenantField
	}
	if input.ExternalID != nil && (input.CreatedByServiceID == nil || !ValidExternalID(*input.ExternalID)) {
		return Tenant{}, ErrInvalidTenantField
	}
	if err := prepareCreateTenantInput(&input); err != nil {
		return Tenant{}, err
	}
	if err := s.checkPublicMediaPlane(input.DefaultMediaPlane); err != nil {
		return Tenant{}, err
	}

	return s.repository.CreateTenant(ctx, input)
}

func (s Service) checkPublicMediaPlane(plane *string) error {
	if plane == nil {
		return nil
	}
	if s.knownMediaPlane == nil || !s.knownMediaPlane(*plane) {
		return ErrInvalidTenantField
	}
	if s.publicMediaPlane == nil || !s.publicMediaPlane(*plane) {
		return ErrMediaPlaneNotPermitted
	}
	return nil
}

func (s Service) GetTenant(ctx context.Context, id utilities.ID) (Tenant, error) {
	if id.IsZero() {
		return Tenant{}, ErrInvalidTenantID
	}

	return s.repository.GetTenant(ctx, id)
}

func (s Service) ListTenants(ctx context.Context, page pagination.PageRequest) (TenantList, error) {
	return s.repository.ListTenants(ctx, page)
}

func (s Service) UpdateTenant(ctx context.Context, id utilities.ID, input UpdateTenantInput) (Tenant, error) {
	if id.IsZero() {
		return Tenant{}, ErrInvalidTenantID
	}
	if err := prepareUpdateTenantInput(&input); err != nil {
		return Tenant{}, err
	}
	if input.DefaultMediaPlane.Set {
		if err := s.checkPublicMediaPlane(input.DefaultMediaPlane.Value); err != nil {
			return Tenant{}, err
		}
	}

	return s.repository.UpdateTenant(ctx, id, input)
}

func (s Service) AllowsOrigin(ctx context.Context, id utilities.ID, origin string) (bool, error) {
	if id.IsZero() {
		return false, ErrInvalidTenantID
	}
	prepared, err := CORSOrigin(origin)
	if err != nil {
		return false, nil
	}
	origins, err := s.repository.GetTenantCORSAllowedOrigins(ctx, id)
	if errors.Is(err, ErrTenantNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, allowed := range origins {
		if allowed == prepared {
			return true, nil
		}
	}
	return false, nil
}

func (s Service) ListServiceTenants(ctx context.Context, serviceID string, page pagination.PageRequest) (TenantList, error) {
	if !ValidServiceID(serviceID) {
		return TenantList{}, ErrInvalidTenantField
	}
	return s.repository.ListServiceTenants(ctx, serviceID, page)
}

func (s Service) FindServiceTenant(ctx context.Context, serviceID, externalID string) (Tenant, error) {
	if !ValidServiceID(serviceID) || !ValidExternalID(externalID) {
		return Tenant{}, ErrInvalidTenantField
	}
	return s.repository.FindServiceTenant(ctx, serviceID, externalID)
}
