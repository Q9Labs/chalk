package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type membershipQuerier interface {
	CreateMembership(ctx context.Context, arg sqlc.CreateMembershipParams) (sqlc.Membership, error)
	ListTenantMemberships(ctx context.Context, arg sqlc.ListTenantMembershipsParams) ([]sqlc.Membership, error)
	UpdateTenantMembership(ctx context.Context, arg sqlc.UpdateTenantMembershipParams) (sqlc.Membership, error)
}

type MembershipRepository struct {
	queries membershipQuerier
}

func NewMembershipRepository(queries membershipQuerier) MembershipRepository {
	return MembershipRepository{queries: queries}
}

func (r MembershipRepository) CreateMembership(ctx context.Context, input memberships.CreateMembershipInput) (memberships.Membership, error) {
	membership, err := r.queries.CreateMembership(ctx, sqlc.CreateMembershipParams{
		ID:       pgtype.UUID{Bytes: input.ID.Bytes(), Valid: true},
		TenantID: pgtype.UUID{Bytes: input.TenantID.Bytes(), Valid: true},
		UserID:   pgtype.UUID{Bytes: input.UserID.Bytes(), Valid: true},
		Role:     string(input.Role),
	})
	if err != nil {
		return memberships.Membership{}, fmt.Errorf("create membership: %w", err)
	}

	return mapMembership(membership), nil
}

func (r MembershipRepository) ListTenantMemberships(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (memberships.MembershipList, error) {
	rows, err := r.queries.ListTenantMemberships(ctx, listTenantMembershipsParams(tenantID, page))
	if err != nil {
		return memberships.MembershipList{}, fmt.Errorf("list tenant memberships: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	response := memberships.MembershipList{
		Memberships: make([]memberships.Membership, 0, len(rows)),
		Page: pagination.Page{
			PageSize: size,
			HasMore:  hasMore,
		},
	}
	for _, row := range rows {
		response.Memberships = append(response.Memberships, mapMembership(row))
	}

	if hasMore && len(response.Memberships) > 0 {
		lastMembership := response.Memberships[len(response.Memberships)-1]
		response.Page.NextCursor = &pagination.Cursor{
			CreatedAt: lastMembership.CreatedAt,
			ID:        lastMembership.ID,
		}
	}

	return response, nil
}

func (r MembershipRepository) UpdateTenantMembership(ctx context.Context, tenantID utilities.ID, membershipID utilities.ID, input memberships.UpdateMembershipInput) (memberships.Membership, error) {
	membership, err := r.queries.UpdateTenantMembership(ctx, sqlc.UpdateTenantMembershipParams{
		Role:     string(input.Role),
		TenantID: pgtype.UUID{Bytes: tenantID.Bytes(), Valid: true},
		ID:       pgtype.UUID{Bytes: membershipID.Bytes(), Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return memberships.Membership{}, memberships.ErrMembershipNotFound
	}
	if err != nil {
		return memberships.Membership{}, fmt.Errorf("update tenant membership: %w", err)
	}

	return mapMembership(membership), nil
}

func listTenantMembershipsParams(tenantID utilities.ID, page pagination.PageRequest) sqlc.ListTenantMembershipsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantMembershipsParams{
		TenantID: pgtype.UUID{Bytes: tenantID.Bytes(), Valid: true},
		PageSize: int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = pgtype.UUID{Bytes: cursor.ID.Bytes(), Valid: true}
	return params
}

func mapMembership(membership sqlc.Membership) memberships.Membership {
	return memberships.Membership{
		ID:        utilities.IDFromBytes(membership.ID.Bytes),
		TenantID:  utilities.IDFromBytes(membership.TenantID.Bytes),
		UserID:    utilities.IDFromBytes(membership.UserID.Bytes),
		Role:      memberships.Role(membership.Role),
		UpdatedAt: timestamp(membership.UpdatedAt),
		CreatedAt: timestamp(membership.CreatedAt),
	}
}

var _ memberships.MembershipRepository = MembershipRepository{}
