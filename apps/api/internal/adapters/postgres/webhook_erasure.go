package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

// EraseUserWebhookEvents destroys user-linked payloads and terminally fences
// every affected delivery. Callers must invoke this before deleting the user,
// while linked_user_id still identifies the rows to erase.
func (r WebhookRepository) EraseUserWebhookEvents(ctx context.Context, userID utilities.ID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `select id from users where id=$1 for update`, uuid(userID)); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `select d.tenant_id,d.id,d.queued_journey_event_id,d.attempt_count,q.journey_id from webhook_events e join webhook_deliveries d on d.tenant_id=e.tenant_id and d.event_id=e.id join observability_journey_events q on q.event_id=d.queued_journey_event_id where e.linked_user_id=$1 and e.erased_at is null and d.state in ('pending','retry_wait','delivering') order by d.created_at for update of e,d`, uuid(userID))
	if err != nil {
		return err
	}
	type affectedDelivery struct {
		tenantID, deliveryID, queuedJourneyEventID, journeyID pgtype.UUID
		attemptNumber                                         int32
	}
	var affected []affectedDelivery
	for rows.Next() {
		var value affectedDelivery
		if err := rows.Scan(&value.tenantID, &value.deliveryID, &value.queuedJourneyEventID, &value.attemptNumber, &value.journeyID); err != nil {
			rows.Close()
			return err
		}
		affected = append(affected, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `update webhook_events set body=null,erased_at=now() where linked_user_id=$1 and erased_at is null`, uuid(userID)); err != nil {
		return err
	}
	for _, value := range affected {
		terminalID, err := utilities.NewID()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update webhook_deliveries set state='erased',next_attempt_at=null,terminal_at=now(),terminal_journey_event_id=$1,lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=now() where tenant_id=$2 and id=$3`, uuid(terminalID), value.tenantID, value.deliveryID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update webhook_delivery_attempts set outcome='terminal_failure',finished_at=now(),latency_milliseconds=greatest(0,extract(epoch from (now()-started_at))*1000)::integer,error_code='event_erased' where tenant_id=$1 and delivery_id=$2 and outcome='started'`, value.tenantID, value.deliveryID); err != nil {
			return err
		}
		parentID := id(value.queuedJourneyEventID)
		var attemptJourneyID pgtype.UUID
		if err := tx.QueryRow(ctx, `select event_id from observability_journey_events where journey_id=$1 and parent_event_id=$2 and name='webhook.delivery.attempt_started' order by sequence desc limit 1`, value.journeyID, value.queuedJourneyEventID).Scan(&attemptJourneyID); err == nil {
			parentID = id(attemptJourneyID)
		} else if err != pgx.ErrNoRows {
			return err
		}
		if err := insertWebhookJourneyEvent(ctx, tx, terminalID, id(value.journeyID), int64(3+int(value.attemptNumber)*2), "webhook.delivery.erased", "erased", parentID, "", "", map[string]any{"delivery_id": id(value.deliveryID).String(), "reason": "user_erasure"}); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `update webhook_events set linked_user_id=null where linked_user_id=$1 and erased_at is not null`, uuid(userID)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	webhooks.RecordTerminalDeliveries(ctx, "erased", int64(len(affected)))
	return nil
}
