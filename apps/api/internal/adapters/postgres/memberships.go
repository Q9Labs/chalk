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
	CreateMembership(ctx context.Context, arg sqlc.CreateMembershipParams) (sqlc.CreateMembershipRow, error)
	GetTenantMembershipForUser(ctx context.Context, arg sqlc.GetTenantMembershipForUserParams) (sqlc.Membership, error)
	ListTenantMemberships(ctx context.Context, arg sqlc.ListTenantMembershipsParams) ([]sqlc.ListTenantMembershipsRow, error)
	UpdateTenantMembership(ctx context.Context, arg sqlc.UpdateTenantMembershipParams) (sqlc.UpdateTenantMembershipRow, error)
}

type MembershipRepository struct {
	queries    membershipQuerier
	transactor accountTenantTransactor
	decorate   func(sqlc.Querier) sqlc.Querier
}

func NewMembershipRepository(queries membershipQuerier, transactor accountTenantTransactor, decorators ...func(sqlc.Querier) sqlc.Querier) MembershipRepository {
	repository := MembershipRepository{queries: queries, transactor: transactor}
	if len(decorators) > 0 {
		repository.decorate = decorators[0]
	}
	return repository
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

	return mapCreateMembership(membership), nil
}

func (r MembershipRepository) GetTenantMembershipForUser(ctx context.Context, tenantID utilities.ID, userID utilities.ID) (memberships.Membership, error) {
	membership, err := r.queries.GetTenantMembershipForUser(ctx, sqlc.GetTenantMembershipForUserParams{
		TenantID: pgtype.UUID{Bytes: tenantID.Bytes(), Valid: true},
		UserID:   pgtype.UUID{Bytes: userID.Bytes(), Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return memberships.Membership{}, memberships.ErrMembershipNotFound
	}
	if err != nil {
		return memberships.Membership{}, fmt.Errorf("get tenant membership for user: %w", err)
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
		response.Memberships = append(response.Memberships, mapListedMembership(row))
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
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return memberships.Membership{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockMembershipTenant(ctx, tx, tenantID); err != nil {
		return memberships.Membership{}, err
	}
	if input.Role != memberships.RoleOwner {
		if err = protectLastOwner(ctx, tx, tenantID, membershipID); err != nil {
			return memberships.Membership{}, err
		}
	}
	var queries membershipQuerier = sqlc.New(tx)
	if r.decorate != nil {
		queries = r.decorate(sqlc.New(tx))
	}
	value, err := queries.UpdateTenantMembership(ctx, sqlc.UpdateTenantMembershipParams{TenantID: uuid(tenantID), ID: uuid(membershipID), Role: string(input.Role)})
	if errors.Is(err, pgx.ErrNoRows) {
		return memberships.Membership{}, memberships.ErrMembershipNotFound
	}
	if err != nil {
		return memberships.Membership{}, err
	}
	return mapUpdatedMembership(value), tx.Commit(ctx)
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

func mapCreateMembership(membership sqlc.CreateMembershipRow) memberships.Membership {
	return membershipWithUser(membership.ID, membership.TenantID, membership.UserID, membership.Role, membership.UserName, membership.UserEmail, membership.UpdatedAt, membership.CreatedAt)
}

func mapListedMembership(membership sqlc.ListTenantMembershipsRow) memberships.Membership {
	return membershipWithUser(membership.ID, membership.TenantID, membership.UserID, membership.Role, membership.UserName, membership.UserEmail, membership.UpdatedAt, membership.CreatedAt)
}

func mapUpdatedMembership(membership sqlc.UpdateTenantMembershipRow) memberships.Membership {
	return membershipWithUser(membership.ID, membership.TenantID, membership.UserID, membership.Role, membership.UserName, membership.UserEmail, membership.UpdatedAt, membership.CreatedAt)
}

func membershipWithUser(id, tenantID, userID pgtype.UUID, role, userName, userEmail string, updatedAt, createdAt pgtype.Timestamptz) memberships.Membership {
	return memberships.Membership{
		ID:        utilities.IDFromBytes(id.Bytes),
		TenantID:  utilities.IDFromBytes(tenantID.Bytes),
		UserID:    utilities.IDFromBytes(userID.Bytes),
		UserName:  userName,
		UserEmail: userEmail,
		Role:      memberships.Role(role),
		UpdatedAt: timestamp(updatedAt),
		CreatedAt: timestamp(createdAt),
	}
}

var _ memberships.MembershipRepository = MembershipRepository{}
