package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/tenanthandovers"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TenantHandoverRepository struct {
	pool *pgxpool.Pool
}

func NewTenantHandoverRepository(pool *pgxpool.Pool) TenantHandoverRepository {
	return TenantHandoverRepository{pool: pool}
}

func (r TenantHandoverRepository) Create(ctx context.Context, input tenanthandovers.CreateInput, now time.Time, fingerprint [32]byte) (tenanthandovers.Handover, bool, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return tenanthandovers.Handover{}, false, err
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	owner, err := lockHandoverTenant(ctx, q, input.TenantID)
	if err != nil {
		return tenanthandovers.Handover{}, false, err
	}
	if owner == "" {
		return tenanthandovers.Handover{}, false, tenanthandovers.ErrOwnershipChanged
	}
	if input.Actor.Kind == tenanthandovers.ActorService && owner != input.Actor.ServiceID {
		return tenanthandovers.Handover{}, false, tenanthandovers.ErrForbidden
	}
	if input.Actor.Kind == tenanthandovers.ActorService {
		input.FromServiceID = input.Actor.ServiceID
	} else {
		input.FromServiceID = owner
	}
	expires := now.Add(time.Duration(input.ExpiresInSeconds) * time.Second)
	row, err := q.CreateTenantHandover(ctx, sqlc.CreateTenantHandoverParams{
		ID: uuid(input.ID), TenantID: uuid(input.TenantID), RecipientEmail: input.RecipientEmail,
		RequestKey: input.RequestKey, RequestFingerprint: fingerprint[:], FromServiceID: input.FromServiceID, ToServiceID: input.ToServiceID,
		InitiatedByKind: input.Actor.Kind, InitiatedByServiceID: optionalText(input.Actor.ServiceID), InitiatedByOperator: optionalText(input.Actor.Operator),
		ExpiresAt: timestampValue(expires),
	})
	if err == nil {
		return mapTenantHandover(row), false, tx.Commit(ctx)
	}
	if isUniqueViolation(err) {
		return tenanthandovers.Handover{}, false, tenanthandovers.ErrHandoverAlreadyPending
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.Handover{}, false, fmt.Errorf("create tenant handover: %w", err)
	}
	existing, getErr := q.GetTenantHandoverByRequestKey(ctx, sqlc.GetTenantHandoverByRequestKeyParams{TenantID: uuid(input.TenantID), RequestKey: input.RequestKey})
	if getErr != nil {
		return tenanthandovers.Handover{}, false, fmt.Errorf("get tenant handover idempotency record: %w", getErr)
	}
	if !bytes.Equal(existing.RequestFingerprint, fingerprint[:]) {
		return tenanthandovers.Handover{}, false, tenanthandovers.ErrIdempotencyConflict
	}
	return mapTenantHandover(existing), true, tx.Commit(ctx)
}

func (r TenantHandoverRepository) GetForTenant(ctx context.Context, tenantID, handoverID utilities.ID) (tenanthandovers.Handover, error) {
	row, err := sqlc.New(r.pool).GetTenantHandover(ctx, sqlc.GetTenantHandoverParams{TenantID: uuid(tenantID), ID: uuid(handoverID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.Handover{}, tenanthandovers.ErrHandoverNotFound
	}
	if err != nil {
		return tenanthandovers.Handover{}, fmt.Errorf("get tenant handover: %w", err)
	}
	return mapTenantHandover(row), nil
}

func (r TenantHandoverRepository) Get(ctx context.Context, handoverID utilities.ID) (tenanthandovers.Handover, error) {
	row, err := sqlc.New(r.pool).GetTenantHandoverByID(ctx, uuid(handoverID))
	if errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.Handover{}, tenanthandovers.ErrHandoverNotFound
	}
	if err != nil {
		return tenanthandovers.Handover{}, fmt.Errorf("get tenant handover: %w", err)
	}
	return mapTenantHandover(row), nil
}

func (r TenantHandoverRepository) LatestAcceptedForEmail(ctx context.Context, email string) (tenanthandovers.Handover, error) {
	row, err := sqlc.New(r.pool).GetLatestAcceptedTenantHandoverForEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.Handover{}, tenanthandovers.ErrHandoverNotFound
	}
	if err != nil {
		return tenanthandovers.Handover{}, fmt.Errorf("get latest accepted tenant handover: %w", err)
	}
	return mapTenantHandover(row), nil
}

func (r TenantHandoverRepository) Cancel(ctx context.Context, input tenanthandovers.CancelInput, now time.Time) (tenanthandovers.Handover, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return tenanthandovers.Handover{}, err
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	if _, err := lockHandoverTenant(ctx, q, input.TenantID); err != nil {
		return tenanthandovers.Handover{}, err
	}
	row, err := q.LockTenantHandover(ctx, uuid(input.HandoverID))
	if errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.Handover{}, tenanthandovers.ErrHandoverNotFound
	}
	if err != nil {
		return tenanthandovers.Handover{}, err
	}
	if !row.TenantID.Valid || utilities.IDFromBytes(row.TenantID.Bytes) != input.TenantID {
		return tenanthandovers.Handover{}, tenanthandovers.ErrHandoverNotFound
	}
	if input.Actor.Kind == tenanthandovers.ActorService && input.Actor.ServiceID != row.FromServiceID {
		return tenanthandovers.Handover{}, tenanthandovers.ErrForbidden
	}
	if row.Status == tenanthandovers.StatusCanceled {
		return mapTenantHandover(row), tx.Commit(ctx)
	}
	if row.Status == tenanthandovers.StatusAccepted {
		return tenanthandovers.Handover{}, tenanthandovers.ErrHandoverAlreadyAccepted
	}
	if !row.ExpiresAt.Time.After(now) {
		return tenanthandovers.Handover{}, tenanthandovers.ErrHandoverExpired
	}
	updated, err := q.CancelTenantHandover(ctx, sqlc.CancelTenantHandoverParams{
		CanceledByKind: optionalText(input.Actor.Kind), CanceledByServiceID: optionalText(input.Actor.ServiceID),
		CanceledByOperator: optionalText(input.Actor.Operator), CanceledAt: timestampValue(now), ID: uuid(input.HandoverID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.Handover{}, tenanthandovers.ErrHandoverExpired
	}
	if err != nil {
		return tenanthandovers.Handover{}, fmt.Errorf("cancel tenant handover: %w", err)
	}
	return mapTenantHandover(updated), tx.Commit(ctx)
}

func (r TenantHandoverRepository) Accept(ctx context.Context, input tenanthandovers.AcceptInput, now time.Time) (tenanthandovers.AcceptResult, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return tenanthandovers.AcceptResult{}, err
	}
	defer tx.Rollback(ctx)
	q := sqlc.New(tx)
	initial, err := q.GetTenantHandoverByID(ctx, uuid(input.HandoverID))
	if errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.AcceptResult{}, tenanthandovers.ErrHandoverNotFound
	}
	if err != nil {
		return tenanthandovers.AcceptResult{}, err
	}
	tenantID := utilities.IDFromBytes(initial.TenantID.Bytes)
	owner, err := lockHandoverTenant(ctx, q, tenantID)
	if err != nil {
		return tenanthandovers.AcceptResult{}, err
	}
	row, err := q.LockTenantHandover(ctx, uuid(input.HandoverID))
	if err != nil {
		return tenanthandovers.AcceptResult{}, err
	}
	if row.Status == tenanthandovers.StatusAccepted {
		if input.RecipientEmail == row.RecipientEmail {
			return tenanthandovers.AcceptResult{Handover: mapTenantHandover(row), UserID: nullableID(row.AcceptedByUserID)}, tx.Commit(ctx)
		}
		return tenanthandovers.AcceptResult{}, tenanthandovers.ErrHandoverAlreadyAccepted
	}
	if row.Status == tenanthandovers.StatusCanceled {
		return tenanthandovers.AcceptResult{}, tenanthandovers.ErrHandoverCanceled
	}
	if !row.ExpiresAt.Time.After(now) {
		return tenanthandovers.AcceptResult{}, tenanthandovers.ErrHandoverExpired
	}
	if input.RecipientEmail != row.RecipientEmail {
		return tenanthandovers.AcceptResult{}, tenanthandovers.ErrRecipientMismatch
	}
	if owner != row.FromServiceID {
		return tenanthandovers.AcceptResult{}, tenanthandovers.ErrOwnershipChanged
	}
	if err := q.LockTenantHandoverUserEmail(ctx, input.RecipientEmail); err != nil {
		return tenanthandovers.AcceptResult{}, err
	}
	userPG, err := q.GetTenantHandoverUserID(ctx, input.RecipientEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		newID, idErr := utilities.NewID()
		if idErr != nil {
			return tenanthandovers.AcceptResult{}, idErr
		}
		userPG, err = q.CreateTenantHandoverUser(ctx, sqlc.CreateTenantHandoverUserParams{ID: uuid(newID), Name: input.RecipientName, Email: input.RecipientEmail})
	}
	if err != nil {
		return tenanthandovers.AcceptResult{}, fmt.Errorf("upsert handover user: %w", err)
	}
	userID := nullableID(userPG)
	membershipID, err := utilities.NewID()
	if err != nil {
		return tenanthandovers.AcceptResult{}, err
	}
	if _, err = q.UpsertTenantHandoverOwnerMembership(ctx, sqlc.UpsertTenantHandoverOwnerMembershipParams{ID: uuid(membershipID), TenantID: uuid(tenantID), UserID: userPG}); err != nil {
		return tenanthandovers.AcceptResult{}, fmt.Errorf("upsert handover owner membership: %w", err)
	}
	if _, err = q.TransferTenantHandoverOwnership(ctx, sqlc.TransferTenantHandoverOwnershipParams{
		ToServiceID: optionalText(row.ToServiceID), TransferredAt: timestampValue(now), TenantID: uuid(tenantID), FromServiceID: optionalText(row.FromServiceID),
	}); errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.AcceptResult{}, tenanthandovers.ErrOwnershipChanged
	} else if err != nil {
		return tenanthandovers.AcceptResult{}, fmt.Errorf("transfer tenant ownership: %w", err)
	}
	if _, err = q.RevokeTenantHandoverAPIKeys(ctx, sqlc.RevokeTenantHandoverAPIKeysParams{RevokedAt: timestampValue(now), TenantID: uuid(tenantID)}); err != nil {
		return tenanthandovers.AcceptResult{}, fmt.Errorf("revoke tenant API keys: %w", err)
	}
	if _, err = q.DisableTenantHandoverWebhookEndpoints(ctx, sqlc.DisableTenantHandoverWebhookEndpointsParams{DisabledAt: timestampValue(now), TenantID: uuid(tenantID)}); err != nil {
		return tenanthandovers.AcceptResult{}, fmt.Errorf("disable tenant webhook endpoints: %w", err)
	}
	if _, err = q.CancelTenantHandoverWebhookDeliveries(ctx, sqlc.CancelTenantHandoverWebhookDeliveriesParams{CanceledAt: timestampValue(now), TenantID: uuid(tenantID)}); err != nil {
		return tenanthandovers.AcceptResult{}, fmt.Errorf("cancel tenant webhook deliveries: %w", err)
	}
	updated, err := q.AcceptTenantHandover(ctx, sqlc.AcceptTenantHandoverParams{AcceptedByUserID: userPG, AcceptedAt: timestampValue(now), ID: uuid(input.HandoverID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenanthandovers.AcceptResult{}, tenanthandovers.ErrHandoverExpired
	}
	if err != nil {
		return tenanthandovers.AcceptResult{}, fmt.Errorf("accept tenant handover: %w", err)
	}
	return tenanthandovers.AcceptResult{Handover: mapTenantHandover(updated), UserID: userID}, tx.Commit(ctx)
}

func lockHandoverTenant(ctx context.Context, q *sqlc.Queries, tenantID utilities.ID) (string, error) {
	row, err := q.LockTenantHandoverTenant(ctx, uuid(tenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", tenants.ErrTenantNotFound
	}
	if err != nil {
		return "", fmt.Errorf("lock handover tenant: %w", err)
	}
	return nullableString(row.CreatedByServiceID), nil
}

func mapTenantHandover(row sqlc.TenantHandover) tenanthandovers.Handover {
	h := tenanthandovers.Handover{
		ID: utilities.IDFromBytes(row.ID.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), RecipientEmail: row.RecipientEmail,
		Status: row.Status, RequestKey: row.RequestKey, FromServiceID: row.FromServiceID, ToServiceID: row.ToServiceID,
		InitiatedBy:      tenanthandovers.Actor{Kind: row.InitiatedByKind, ServiceID: nullableString(row.InitiatedByServiceID), Operator: nullableString(row.InitiatedByOperator)},
		AcceptedByUserID: nullableID(row.AcceptedByUserID), AcceptedAt: nullableTimestamp(row.AcceptedAt), CanceledAt: nullableTimestamp(row.CanceledAt),
		ExpiresAt: row.ExpiresAt.Time.UTC(), UpdatedAt: timestamp(row.UpdatedAt), CreatedAt: timestamp(row.CreatedAt),
	}
	if row.CanceledByKind.Valid {
		h.CanceledBy = &tenanthandovers.Actor{Kind: row.CanceledByKind.String, ServiceID: nullableString(row.CanceledByServiceID), Operator: nullableString(row.CanceledByOperator)}
	}
	return h
}

func timestampValue(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}
