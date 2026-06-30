package tenants

import (
	"context"
	"errors"
)

var (
	ErrInvalidTenantID = errors.New("invalid tenant id")
	ErrTenantNotFound  = errors.New("tenant not found")
)

type Tenant struct {
	ID                TenantID
	Name              string
	DefaultRegion     *string
	DefaultMediaPlane *string
	LogoKey           *string
	Website           *string
}

type Store interface {
	GetTenant(ctx context.Context, id TenantID) (Tenant, error)
}

type Service struct {
	store Store
}

func NewService(store Store) Service {
	return Service{store: store}
}

func (s Service) GetTenant(ctx context.Context, id TenantID) (Tenant, error) {
	if id.IsZero() {
		return Tenant{}, ErrInvalidTenantID
	}

	return s.store.GetTenant(ctx, id)
}
