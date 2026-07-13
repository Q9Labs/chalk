package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func insertWebhookAudit(ctx context.Context, tx pgx.Tx, tenantID utilities.ID, action, resourceType string, resourceID utilities.ID, details map[string]any) error {
	return insertWebhookAuditOutcome(ctx, tx, tenantID, action, resourceType, resourceID, details, auditlogs.OutcomeSuccess, "")
}

func insertWebhookAuditOutcome(ctx context.Context, tx pgx.Tx, tenantID utilities.ID, action, resourceType string, resourceID utilities.ID, details map[string]any, outcome, errorCode string) error {
	id, err := utilities.NewID()
	if err != nil {
		return err
	}
	body, err := json.Marshal(details)
	if err != nil {
		return fmt.Errorf("marshal webhook audit details: %w", err)
	}
	actorType, actorUserID := auditlogs.ActorSystem, utilities.ID{}
	if principal, ok := authentication.PrincipalFromContext(ctx); ok {
		actorType, actorUserID = auditlogs.PrincipalActor(principal)
	}
	_, err = sqlc.New(tx).CreateAuditLog(ctx, sqlc.CreateAuditLogParams{
		ID: uuid(id), TenantID: uuid(tenantID), ActorUserID: nullableUUID(actorUserID), ActorType: actorType,
		Action: action, ResourceType: pgtype.Text{String: resourceType, Valid: true}, ResourceID: uuid(resourceID),
		Details: body, Outcome: outcome, ErrorCode: pgtype.Text{String: errorCode, Valid: errorCode != ""},
	})
	if err != nil {
		return fmt.Errorf("create webhook audit log: %w", err)
	}
	return nil
}

func (r WebhookRepository) RecordWebhookFailure(ctx context.Context, input webhooks.FailureAuditInput) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := insertWebhookAuditOutcome(ctx, tx, input.TenantID, input.Action, input.ResourceType, input.ResourceID, map[string]any{}, auditlogs.OutcomeFailure, input.ErrorCode); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

var _ webhooks.FailureAuditor = WebhookRepository{}
