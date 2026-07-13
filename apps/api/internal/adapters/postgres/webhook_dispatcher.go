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

func (r WebhookDispatchRepository) RecoverExpired(ctx context.Context) (int64, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `select d.tenant_id,d.id,d.event_id,d.attempt_count,d.lease_token,d.queued_journey_event_id,e.occurred_at,q.journey_id from webhook_deliveries d join webhook_events e on e.tenant_id=d.tenant_id and e.id=d.event_id join observability_journey_events q on q.event_id=d.queued_journey_event_id where d.state='delivering' and d.lease_expires_at<=now() order by d.lease_expires_at for update of d skip locked limit 100`)
	if err != nil {
		return 0, err
	}
	type expiredLease struct {
		tenantID, deliveryID, eventID, leaseToken, queuedJourneyEventID, journeyID pgtype.UUID
		attemptNumber                                                              int32
		occurredAt                                                                 pgtype.Timestamptz
	}
	var expired []expiredLease
	var exhaustedCount int64
	for rows.Next() {
		var value expiredLease
		if err := rows.Scan(&value.tenantID, &value.deliveryID, &value.eventID, &value.attemptNumber, &value.leaseToken, &value.queuedJourneyEventID, &value.occurredAt, &value.journeyID); err != nil {
			rows.Close()
			return 0, err
		}
		expired = append(expired, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for _, lease := range expired {
		finishedAt := time.Now().UTC()
		deliveryID := id(lease.deliveryID)
		next := webhooks.NextAttemptAt(deliveryID, timestamp(lease.occurredAt), finishedAt, int(lease.attemptNumber)+1, 0)
		state := "retry_wait"
		journeyName := "webhook.delivery.retry_scheduled"
		if next == nil {
			state = "exhausted"
			journeyName = "webhook.delivery.exhausted"
		}
		branchID, err := utilities.NewID()
		if err != nil {
			return 0, err
		}
		command, err := tx.Exec(ctx, `update webhook_deliveries set state=$1,next_attempt_at=$2::timestamptz,terminal_at=case when $1='exhausted' then $3::timestamptz else null::timestamptz end,terminal_journey_event_id=case when $1='exhausted' then $4::uuid else null::uuid end,lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=$3::timestamptz where tenant_id=$5 and id=$6 and state='delivering' and lease_token=$7`, state, timestamptz(next), finishedAt, uuid(branchID), lease.tenantID, lease.deliveryID, lease.leaseToken)
		if err != nil {
			return 0, err
		}
		if command.RowsAffected() == 0 {
			continue
		}
		if state == "exhausted" {
			exhaustedCount++
		}
		if _, err := tx.Exec(ctx, `update webhook_delivery_attempts set outcome='lease_expired',finished_at=$1,latency_milliseconds=greatest(0,extract(epoch from ($1-started_at))*1000)::integer,error_code='lease_expired' where tenant_id=$2 and delivery_id=$3 and attempt_number=$4 and outcome='started'`, finishedAt, lease.tenantID, lease.deliveryID, lease.attemptNumber); err != nil {
			return 0, err
		}
		parentID := id(lease.queuedJourneyEventID)
		var attemptJourneyID pgtype.UUID
		if err := tx.QueryRow(ctx, `select event_id from observability_journey_events where journey_id=$1 and parent_event_id=$2 and name='webhook.delivery.attempt_started' order by sequence desc limit 1`, lease.journeyID, lease.queuedJourneyEventID).Scan(&attemptJourneyID); err == nil {
			parentID = id(attemptJourneyID)
		} else if err != pgx.ErrNoRows {
			return 0, err
		}
		if err := insertWebhookJourneyEvent(ctx, tx, branchID, id(lease.journeyID), int64(3+int(lease.attemptNumber)*2), journeyName, state, parentID, "", "", map[string]any{"attempt_number": lease.attemptNumber, "delivery_id": deliveryID.String(), "error_code": "lease_expired", "status_class": "none"}); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	webhooks.RecordTerminalDeliveries(ctx, "exhausted", exhaustedCount)
	return int64(len(expired)), nil
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
	return webhooks.Claim{TenantID: id(delivery.TenantID), EndpointID: id(delivery.EndpointID), EndpointRevisionID: id(delivery.EndpointRevisionID), DeliveryID: id(delivery.ID), EventID: id(delivery.EventID), AttemptNumber: int(delivery.AttemptCount), EventName: eventName, APIVersion: int(apiVersion), OccurredAt: timestamp(occurredAt), Body: body, URLCiphertext: urlCiphertext, CurrentSecretCiphertext: currentSecret, PreviousSecretCiphertext: previousSecret, PreviousSecretExpiresAt: nullableTimestamp(previousExpires), LeaseToken: token, JourneyID: id(journeyID), QueuedJourneyEventID: id(delivery.QueuedJourneyEventID), AttemptParentJourneyEventID: parentID, ProducingTraceID: traceID.String, ProducingSpanID: spanID.String}, nil
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

func (r WebhookDispatchRepository) Cleanup(ctx context.Context) error {
	if err := r.terminalizeExpired(ctx); err != nil {
		return err
	}
	queries := sqlc.New(r.pool)
	if err := drainWebhookCleanup(func() (int64, error) { return queries.CleanupExpiredWebhookAttempts(ctx) }); err != nil {
		return err
	}
	if err := drainWebhookCleanup(func() (int64, error) { return queries.CleanupExpiredWebhookDeliveries(ctx) }); err != nil {
		return err
	}
	if err := drainWebhookCleanup(func() (int64, error) { return queries.CleanupExpiredWebhookEvents(ctx) }); err != nil {
		return err
	}
	if err := drainWebhookCleanup(func() (int64, error) { return queries.CleanupExpiredWebhookIdempotency(ctx) }); err != nil {
		return err
	}
	if err := drainWebhookCleanup(func() (int64, error) { return queries.CleanupExpiredWebhookPreviousSecrets(ctx) }); err != nil {
		return err
	}
	return drainWebhookCleanup(func() (int64, error) { return queries.CleanupDeletedWebhookEndpoints(ctx) })
}

func (r WebhookDispatchRepository) terminalizeExpired(ctx context.Context) error {
	for batch := 0; batch < webhookCleanupMaxBatches; batch++ {
		count, err := r.terminalizeExpiredBatch(ctx)
		if err != nil {
			return err
		}
		if count < webhookCleanupBatchSize {
			return nil
		}
	}
	return nil
}

func (r WebhookDispatchRepository) terminalizeExpiredBatch(ctx context.Context) (int64, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `select d.tenant_id,d.id,d.queued_journey_event_id,d.attempt_count,q.journey_id from webhook_deliveries d join webhook_events e on e.tenant_id=d.tenant_id and e.id=d.event_id join observability_journey_events q on q.event_id=d.queued_journey_event_id where e.occurred_at<now()-interval '30 days' and d.state in ('pending','retry_wait','delivering') order by e.occurred_at,d.created_at for update of d skip locked limit 1000`)
	if err != nil {
		return 0, err
	}
	type expiredDelivery struct {
		tenantID, deliveryID, queuedJourneyEventID, journeyID pgtype.UUID
		attemptNumber                                         int32
	}
	var deliveries []expiredDelivery
	for rows.Next() {
		var delivery expiredDelivery
		if err := rows.Scan(&delivery.tenantID, &delivery.deliveryID, &delivery.queuedJourneyEventID, &delivery.attemptNumber, &delivery.journeyID); err != nil {
			rows.Close()
			return 0, err
		}
		deliveries = append(deliveries, delivery)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for _, delivery := range deliveries {
		terminalID, err := utilities.NewID()
		if err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `update webhook_deliveries set state='exhausted',next_attempt_at=null,terminal_at=now(),terminal_journey_event_id=$1,lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=now() where tenant_id=$2 and id=$3 and state in ('pending','retry_wait','delivering')`, uuid(terminalID), delivery.tenantID, delivery.deliveryID); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `update webhook_delivery_attempts set outcome='terminal_failure',finished_at=now(),latency_milliseconds=greatest(0,extract(epoch from (now()-started_at))*1000)::integer,error_code='retention_expired' where tenant_id=$1 and delivery_id=$2 and outcome='started'`, delivery.tenantID, delivery.deliveryID); err != nil {
			return 0, err
		}
		parentID := id(delivery.queuedJourneyEventID)
		var attemptJourneyID pgtype.UUID
		if err := tx.QueryRow(ctx, `select event_id from observability_journey_events where journey_id=$1 and name='webhook.delivery.attempt_started' and attributes->>'delivery_id'=$2 and (attributes->>'attempt_number')::integer=$3 order by sequence desc limit 1`, delivery.journeyID, id(delivery.deliveryID).String(), delivery.attemptNumber).Scan(&attemptJourneyID); err == nil {
			parentID = id(attemptJourneyID)
		} else if err != pgx.ErrNoRows {
			return 0, err
		}
		if err := insertWebhookJourneyEvent(ctx, tx, terminalID, id(delivery.journeyID), int64(3+int(delivery.attemptNumber)*2), "webhook.delivery.exhausted", "exhausted", parentID, "", "", map[string]any{"attempt_number": delivery.attemptNumber, "delivery_id": id(delivery.deliveryID).String(), "error_code": "retention_expired", "status_class": "none"}); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	webhooks.RecordTerminalDeliveries(ctx, "exhausted", int64(len(deliveries)))
	return int64(len(deliveries)), nil
}

const (
	webhookCleanupBatchSize  = int64(1000)
	webhookCleanupMaxBatches = 10
)

func drainWebhookCleanup(run func() (int64, error)) error {
	for batch := 0; batch < webhookCleanupMaxBatches; batch++ {
		rows, err := run()
		if err != nil {
			return err
		}
		if rows < webhookCleanupBatchSize {
			return nil
		}
	}
	return nil
}

var _ webhooks.DispatchRepository = WebhookDispatchRepository{}
