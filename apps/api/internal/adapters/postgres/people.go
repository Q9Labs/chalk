package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type PeopleRepository struct{ database accountTenantTransactor }

func NewPeopleRepository(database accountTenantTransactor) PeopleRepository {
	return PeopleRepository{database: database}
}

func lockMembershipTenant(ctx context.Context, tx pgx.Tx, id utilities.ID) error {
	var locked pgtype.UUID
	return tx.QueryRow(ctx, `select id from tenants where id=$1 for update`, uuid(id)).Scan(&locked)
}
func scanInvitation(row pgx.Row) (memberships.Invitation, error) {
	var invitation memberships.Invitation
	var id, tenant pgtype.UUID
	err := row.Scan(&id, &tenant, &invitation.Email, &invitation.Role, &invitation.ExpiresAt, &invitation.CreatedAt)
	invitation.ID = utilities.IDFromBytes(id.Bytes)
	invitation.TenantID = utilities.IDFromBytes(tenant.Bytes)
	return invitation, err
}

const invitationColumns = `id,tenant_id,email,role,expires_at,created_at`

func (r PeopleRepository) IssueInvitation(ctx context.Context, input memberships.IssueInvitationInput) (memberships.Invitation, error) {
	tx, err := r.database.Begin(ctx)
	if err != nil {
		return memberships.Invitation{}, err
	}
	defer tx.Rollback(ctx)
	if err = lockMembershipTenant(ctx, tx, input.TenantID); err != nil {
		return memberships.Invitation{}, err
	}
	if _, err = tx.Exec(ctx, `update tenant_invitations set revoked_at=clock_timestamp() where tenant_id=$1 and email=$2 and consumed_at is null and revoked_at is null`, uuid(input.TenantID), input.Email); err != nil {
		return memberships.Invitation{}, err
	}
	invitation, err := scanInvitation(tx.QueryRow(ctx, `insert into tenant_invitations(id,tenant_id,email,role,token_hash,expires_at) values($1,$2,$3,$4,$5,$6) returning `+invitationColumns, uuid(input.ID), uuid(input.TenantID), input.Email, string(input.Role), input.TokenHash, input.ExpiresAt))
	if err != nil {
		return memberships.Invitation{}, err
	}
	return invitation, tx.Commit(ctx)
}
func (r PeopleRepository) ListInvitations(ctx context.Context, tenant utilities.ID) ([]memberships.Invitation, error) {
	tx, err := r.database.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `select `+invitationColumns+` from tenant_invitations where tenant_id=$1 and consumed_at is null and revoked_at is null and expires_at>clock_timestamp() order by created_at,id`, uuid(tenant))
	if err != nil {
		return nil, err
	}
	result := []memberships.Invitation{}
	for rows.Next() {
		invitation, err := scanInvitation(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, invitation)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}
func (r PeopleRepository) RevokeInvitation(ctx context.Context, tenant, id utilities.ID) error {
	tx, err := r.database.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockMembershipTenant(ctx, tx, tenant); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `update tenant_invitations set revoked_at=clock_timestamp() where tenant_id=$1 and id=$2 and revoked_at is null and consumed_at is null and expires_at>clock_timestamp()`, uuid(tenant), uuid(id))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return memberships.ErrInvitationUnavailable
	}
	return tx.Commit(ctx)
}
func (r PeopleRepository) AcceptInvitation(ctx context.Context, hash string, account utilities.ID) (memberships.Membership, error) {
	tx, err := r.database.Begin(ctx)
	if err != nil {
		return memberships.Membership{}, err
	}
	defer tx.Rollback(ctx)
	var tenant pgtype.UUID
	err = tx.QueryRow(ctx, `select tenant_id from tenant_invitations where token_hash=$1`, hash).Scan(&tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		return memberships.Membership{}, memberships.ErrInvitationUnavailable
	}
	if err != nil {
		return memberships.Membership{}, err
	}
	if err = lockMembershipTenant(ctx, tx, utilities.IDFromBytes(tenant.Bytes)); err != nil {
		return memberships.Membership{}, err
	}
	invitation, err := scanInvitation(tx.QueryRow(ctx, `select `+invitationColumns+` from tenant_invitations where token_hash=$1 and consumed_at is null and revoked_at is null and expires_at>clock_timestamp() for update`, hash))
	if errors.Is(err, pgx.ErrNoRows) {
		return memberships.Membership{}, memberships.ErrInvitationUnavailable
	}
	if err != nil {
		return memberships.Membership{}, err
	}
	var ownsEmail bool
	if err = tx.QueryRow(ctx, `select exists(select 1 from users where id=$1 and lower(email)=$2)`, uuid(account), invitation.Email).Scan(&ownsEmail); err != nil {
		return memberships.Membership{}, err
	}
	if !ownsEmail {
		return memberships.Membership{}, memberships.ErrInvitationAccount
	}
	id, err := utilities.NewID()
	if err != nil {
		return memberships.Membership{}, err
	}
	// Existing members keep their Role: accepting a link must not demote an Owner.
	value, err := scanPeopleMembership(tx.QueryRow(ctx, `insert into memberships(id,tenant_id,user_id,role) values($1,$2,$3,$4) on conflict(tenant_id,user_id) do update set user_id=excluded.user_id returning id,tenant_id,user_id,role,updated_at,created_at`, uuid(id), tenant, uuid(account), string(invitation.Role)))
	if err != nil {
		return memberships.Membership{}, err
	}
	if _, err = tx.Exec(ctx, `update tenant_invitations set consumed_at=clock_timestamp() where id=$1`, uuid(invitation.ID)); err != nil {
		return memberships.Membership{}, err
	}
	return value, tx.Commit(ctx)
}
func scanPeopleMembership(row pgx.Row) (memberships.Membership, error) {
	var value memberships.Membership
	var id, tenant, account pgtype.UUID
	err := row.Scan(&id, &tenant, &account, &value.Role, &value.UpdatedAt, &value.CreatedAt)
	value.ID = utilities.IDFromBytes(id.Bytes)
	value.TenantID = utilities.IDFromBytes(tenant.Bytes)
	value.UserID = utilities.IDFromBytes(account.Bytes)
	return value, err
}
func protectLastOwner(ctx context.Context, tx pgx.Tx, tenant, id utilities.ID) error {
	var role string
	err := tx.QueryRow(ctx, `select role from memberships where tenant_id=$1 and id=$2`, uuid(tenant), uuid(id)).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return memberships.ErrMembershipNotFound
	}
	if err != nil {
		return err
	}
	if role != "owner" {
		return nil
	}
	var count int
	if err = tx.QueryRow(ctx, `select count(*) from memberships where tenant_id=$1 and role='owner'`, uuid(tenant)).Scan(&count); err != nil {
		return err
	}
	if count <= 1 {
		return memberships.ErrLastOwner
	}
	return nil
}
func (r PeopleRepository) RemoveMembership(ctx context.Context, tenant, id utilities.ID) error {
	return r.remove(ctx, tenant, id, false)
}
func (r PeopleRepository) LeaveTenant(ctx context.Context, tenant, account utilities.ID) error {
	return r.remove(ctx, tenant, account, true)
}
func (r PeopleRepository) remove(ctx context.Context, tenant, id utilities.ID, byAccount bool) error {
	tx, err := r.database.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockMembershipTenant(ctx, tx, tenant); err != nil {
		return err
	}
	if byAccount {
		var membershipID pgtype.UUID
		err = tx.QueryRow(ctx, `select id from memberships where tenant_id=$1 and user_id=$2`, uuid(tenant), uuid(id)).Scan(&membershipID)
		if errors.Is(err, pgx.ErrNoRows) {
			return memberships.ErrMembershipNotFound
		}
		if err != nil {
			return err
		}
		id = utilities.IDFromBytes(membershipID.Bytes)
	}
	if err = protectLastOwner(ctx, tx, tenant, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `delete from memberships where tenant_id=$1 and id=$2`, uuid(tenant), uuid(id)); err != nil {
		return fmt.Errorf("remove membership: %w", err)
	}
	return tx.Commit(ctx)
}
