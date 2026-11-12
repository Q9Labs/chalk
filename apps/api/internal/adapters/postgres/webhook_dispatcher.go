package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

type WebhookDispatchRepository struct{ pool *pgxpool.Pool }

func NewWebhookDispatchRepository(pool *pgxpool.Pool) WebhookDispatchRepository {
	return WebhookDispatchRepository{pool: pool}
}

func (r WebhookDispatchRepository) Claim(ctx context.Context, owner string, batch int, lease time.Duration) ([]webhooks.Claim, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	token, err := utilities.NewID()
	if err != nil {
		return nil, err
	}
	leaseSeconds := int32(lease.Round(time.Second) / time.Second)
	if leaseSeconds < 1 {
		leaseSeconds = 1
	}
	rows, err := sqlc.New(tx).ClaimWebhookDeliveries(ctx, sqlc.ClaimWebhookDeliveriesParams{BatchSize: int32(batch), LeaseToken: uuid(token), LeaseOwner: text(&owner), LeaseDurationSeconds: leaseSeconds})
	if err != nil {
		return nil, fmt.Errorf("claim webhook deliveries: %w", err)
	}
	claims := make([]webhooks.Claim, 0, len(rows))
	for _, row := range rows {
		attemptID, idErr := utilities.NewID()
		if idErr != nil {
			return nil, idErr
		}
		_, err = tx.Exec(ctx, `insert into webhook_delivery_attempts (id,tenant_id,delivery_id,attempt_number,started_at,outcome) values ($1,$2,$3,$4,now(),'started')`, uuid(attemptID), row.TenantID, row.ID, row.AttemptCount)
		if err != nil {
			return nil, err
		}
		claim, err := loadWebhookClaim(ctx, tx, row, token)
		if err != nil {
			return nil, err
		}
		claim.AttemptID = attemptID
		attemptJourneyID, idErr := utilities.NewID()
		if idErr != nil {
			return nil, idErr
		}
		claim.AttemptJourneyEventID = attemptJourneyID
		if err := insertWebhookJourneyEvent(ctx, tx, attemptJourneyID, claim.JourneyID, int64(2+claim.AttemptNumber*2), "webhook.delivery.attempt_started", "started", claim.AttemptParentJourneyEventID, "", "", map[string]any{"attempt_number": claim.AttemptNumber, "delivery_id": claim.DeliveryID.String()}); err != nil {
			return nil, err
		}
		claims = append(claims, claim)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return claims, nil
}

func loadWebhookClaim(ctx context.Context, tx pgx.Tx, delivery sqlc.WebhookDelivery, token utilities.ID) (webhooks.Claim, error) {
	var occurredAt pgtype.Timestamptz
	var eventName string
	var apiVersion int32
	var body, urlCiphertext, currentSecret, previousSecret []byte
	var previousExpires pgtype.Timestamptz
	var journeyID pgtype.UUID
	var traceID, spanID pgtype.Text
	err := tx.QueryRow(ctx, `select e.occurred_at,e.event_name,e.api_version,e.body,r.url_ciphertext,p.current_secret_ciphertext,p.previous_secret_ciphertext,p.previous_secret_expires_at,q.journey_id,e.producing_trace_id,e.producing_span_id from webhook_events e join webhook_endpoint_revisions r on r.tenant_id=e.tenant_id join webhook_endpoints p on p.tenant_id=r.tenant_id and p.id=r.endpoint_id join observability_journey_events q on q.event_id=$5 where e.tenant_id=$1 and e.id=$2 and r.id=$3 and p.id=$4 and e.erased_at is null and r.url_destroyed_at is null and p.deleted_at is null and p.enabled`, delivery.TenantID, delivery.EventID, delivery.EndpointRevisionID, delivery.EndpointID, delivery.QueuedJourneyEventID).Scan(&occurredAt, &eventName, &apiVersion, &body, &urlCiphertext, &currentSecret, &previousSecret, &previousExpires, &journeyID, &traceID, &spanID)
	if err != nil {
		return webhooks.Claim{}, fmt.Errorf("load webhook claim: %w", err)
	}
	parentID := id(delivery.QueuedJourneyEventID)
	if delivery.AttemptCount > 1 {
		var retryID pgtype.UUID
		err := tx.QueryRow(ctx, `select event_id from observability_journey_events where journey_id=$1 and name='webhook.delivery.retry_scheduled' and attributes->>'delivery_id'=$2 and (attributes->>'attempt_number')::integer=$3 order by occurred_at desc limit 1`, journeyID, id(delivery.ID).String(), delivery.AttemptCount-1).Scan(&retryID)
		if err == nil {
			parentID = id(retryID)
		} else if err != pgx.ErrNoRows {
			return webhooks.Claim{}, err
		}
	}
	return webhooks.Claim{TenantID: id(delivery.TenantID), EndpointID: id(delivery.EndpointID), EndpointRevisionID: id(delivery.EndpointRevisionID), DeliveryID: id(delivery.ID), EventID: id(delivery.EventID), AttemptNumber: int(delivery.AttemptCount), EventName: webhooks.EventName(eventName), APIVersion: int(apiVersion), OccurredAt: timestamp(occurredAt), Body: body, URLCiphertext: urlCiphertext, CurrentSecretCiphertext: currentSecret, PreviousSecretCiphertext: previousSecret, PreviousSecretExpiresAt: nullableTimestamp(previousExpires), LeaseToken: token, JourneyID: id(journeyID), QueuedJourneyEventID: id(delivery.QueuedJourneyEventID), AttemptParentJourneyEventID: parentID, ProducingTraceID: traceID.String, ProducingSpanID: spanID.String}, nil
}

func (r WebhookDispatchRepository) RecordAttemptTrace(ctx context.Context, claim webhooks.Claim, traceID, spanID string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `update webhook_delivery_attempts a set trace_id=$1,span_id=$2 from webhook_deliveries d where a.tenant_id=$3 and a.delivery_id=$4 and a.attempt_number=$5 and a.outcome='started' and d.tenant_id=a.tenant_id and d.id=a.delivery_id and d.state='delivering' and d.lease_token=$6`, traceID, spanID, uuid(claim.TenantID), uuid(claim.DeliveryID), claim.AttemptNumber, uuid(claim.LeaseToken))
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return webhooks.ErrDeliveryLeaseLost
	}
	if _, err := tx.Exec(ctx, `update observability_journey_events set trace_id=$1,span_id=$2 where event_id=$3 and journey_id=$4`, traceID, spanID, uuid(claim.AttemptJourneyEventID), uuid(claim.JourneyID)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r WebhookDispatchRepository) Complete(ctx context.Context, claim webhooks.Claim, result webhooks.AttemptResult) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	state, outcome := "exhausted", "terminal_failure"
	var next *time.Time
	if result.Success {
		state, outcome = "succeeded", "succeeded"
	} else if result.Retryable {
		next = webhooks.NextAttemptAt(claim.DeliveryID, claim.OccurredAt, result.FinishedAt, claim.AttemptNumber+1, result.RetryAfter)
		if next != nil {
			state, outcome = "retry_wait", "retryable_failure"
		}
	}
	branchID, idErr := utilities.NewID()
	if idErr != nil {
		return idErr
	}
	terminalID := utilities.ID{}
	if state == "succeeded" || state == "exhausted" {
		terminalID = branchID
	}
	command, err := tx.Exec(ctx, `update webhook_deliveries set state=$1,next_attempt_at=$2::timestamptz,terminal_at=case when $1 in ('succeeded','exhausted') then $3::timestamptz else null::timestamptz end,terminal_journey_event_id=$7,lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=$3::timestamptz where tenant_id=$4 and id=$5 and state='delivering' and lease_token=$6`, state, timestamptz(next), timestamptz(&result.FinishedAt), uuid(claim.TenantID), uuid(claim.DeliveryID), uuid(claim.LeaseToken), uuid(terminalID))
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return webhooks.ErrDeliveryLeaseLost
	}
	var httpStatus, latency pgtype.Int4
	if result.HTTPStatus != 0 {
		httpStatus = pgtype.Int4{Int32: int32(result.HTTPStatus), Valid: true}
	}
	latency = pgtype.Int4{Int32: int32(result.Latency.Milliseconds()), Valid: true}
	errorCode := pgtype.Text{String: result.ErrorCode, Valid: result.ErrorCode != ""}
	attemptCommand, err := tx.Exec(ctx, `update webhook_delivery_attempts set finished_at=$1,latency_milliseconds=$2,outcome=$3,http_status=$4,error_code=$5 where tenant_id=$6 and delivery_id=$7 and attempt_number=$8 and outcome='started'`, timestamptz(&result.FinishedAt), latency, outcome, httpStatus, errorCode, uuid(claim.TenantID), uuid(claim.DeliveryID), int32(claim.AttemptNumber))
	if err != nil {
		return err
	}
	if attemptCommand.RowsAffected() == 0 {
		return webhooks.ErrDeliveryLeaseLost
	}
	journeyName := "webhook.delivery.exhausted"
	if state == "succeeded" {
		journeyName = "webhook.delivery.attempt_succeeded"
	} else if state == "retry_wait" {
		journeyName = "webhook.delivery.retry_scheduled"
	}
	if err := insertWebhookJourneyEvent(ctx, tx, branchID, claim.JourneyID, int64(3+claim.AttemptNumber*2), journeyName, state, claim.AttemptJourneyEventID, "", "", map[string]any{"attempt_number": claim.AttemptNumber, "delivery_id": claim.DeliveryID.String(), "error_code": result.ErrorCode, "status_class": statusClass(result.HTTPStatus)}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func statusClass(status int) string {
	if status < 100 {
		return "none"
	}
	return fmt.Sprintf("%dxx", status/100)
}

var _ webhooks.DispatchRepository = WebhookDispatchRepository{}
