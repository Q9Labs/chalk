package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

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
