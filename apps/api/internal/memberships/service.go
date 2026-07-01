package memberships

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidMembershipID   = errors.New("invalid membership id")
	ErrInvalidMembershipRole = errors.New("invalid membership role")
	ErrInvalidTenantID       = errors.New("invalid tenant id")
	ErrInvalidUserID         = errors.New("invalid user id")
	ErrMembershipNotFound    = errors.New("membership not found")
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
	RoleViewer Role = "viewer"
)

type Membership struct {
	ID        utilities.ID
	TenantID  utilities.ID
	UserID    utilities.ID
	Role      Role
	UpdatedAt time.Time
	CreatedAt time.Time
}

type MembershipRepository interface {
	CreateMembership(ctx context.Context, input CreateMembershipInput) (Membership, error)
	ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (MembershipList, error)
	UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input UpdateMembershipInput) (Membership, error)
}

type Service struct {
	repository MembershipRepository
}

type CreateMembershipInput struct {
	ID       utilities.ID
	TenantID utilities.ID
	UserID   utilities.ID
	Role     Role
}

type UpdateMembershipInput struct {
	Role Role
}

type MembershipList struct {
	Memberships []Membership
	Page        pagination.Page
}

func NewService(repository MembershipRepository) Service {
	return Service{repository: repository}
}

func (s Service) CreateMembership(ctx context.Context, input CreateMembershipInput) (Membership, error) {
	id, err := utilities.NewID()
	if err != nil {
		return Membership{}, err
	}

	input.ID = id
	if err := prepareCreateMembershipInput(&input); err != nil {
		return Membership{}, err
	}

	return s.repository.CreateMembership(ctx, input)
}

func (s Service) ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (MembershipList, error) {
	if tenantID.IsZero() {
		return MembershipList{}, ErrInvalidTenantID
	}

	return s.repository.ListTenantMemberships(ctx, tenantID, page)
}

func (s Service) UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input UpdateMembershipInput) (Membership, error) {
	if tenantID.IsZero() {
		return Membership{}, ErrInvalidTenantID
	}
	if membershipID.IsZero() {
		return Membership{}, ErrInvalidMembershipID
	}
	if !validRole(input.Role) {
		return Membership{}, ErrInvalidMembershipRole
	}

	return s.repository.UpdateTenantMembership(ctx, tenantID, membershipID, input)
}

func prepareCreateMembershipInput(input *CreateMembershipInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.UserID.IsZero() {
		return ErrInvalidUserID
	}
	if !validRole(input.Role) {
		return ErrInvalidMembershipRole
	}

	return nil
}

func validRole(role Role) bool {
	switch role {
	case RoleOwner, RoleAdmin, RoleMember, RoleViewer:
		return true
	default:
		return false
	}
}
