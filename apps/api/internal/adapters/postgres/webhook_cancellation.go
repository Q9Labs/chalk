package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func cancelWebhookDeliveries(ctx context.Context, tx pgx.Tx, tenantID, endpointID utilities.ID, keepRevision *int32, reason string, canceledCount *int64) error {
	rows, err := tx.Query(ctx, `select d.id,d.queued_journey_event_id,d.attempt_count,q.journey_id from webhook_deliveries d join observability_journey_events q on q.event_id=d.queued_journey_event_id where d.tenant_id=$1 and d.endpoint_id=$2 and ($3::integer is null or d.endpoint_revision<>$3) and d.state in ('pending','retry_wait','delivering') order by d.created_at for update of d`, uuid(tenantID), uuid(endpointID), pgtype.Int4{Int32: valueOrZero(keepRevision), Valid: keepRevision != nil})
	if err != nil {
		return err
	}
	type candidate struct {
		deliveryID, queuedJourneyEventID, journeyID pgtype.UUID
		attemptNumber                               int32
	}
	var candidates []candidate
	for rows.Next() {
		var value candidate
		if err := rows.Scan(&value.deliveryID, &value.queuedJourneyEventID, &value.attemptNumber, &value.journeyID); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, value := range candidates {
		terminalID, err := utilities.NewID()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update webhook_deliveries set state='canceled',next_attempt_at=null,terminal_at=now(),terminal_journey_event_id=$1,lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=now() where tenant_id=$2 and id=$3 and state in ('pending','retry_wait','delivering')`, uuid(terminalID), uuid(tenantID), value.deliveryID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update webhook_delivery_attempts set outcome='terminal_failure',finished_at=now(),latency_milliseconds=greatest(0,extract(epoch from (now()-started_at))*1000)::integer,error_code='delivery_canceled' where tenant_id=$1 and delivery_id=$2 and outcome='started'`, uuid(tenantID), value.deliveryID); err != nil {
			return err
		}
		parentID := id(value.queuedJourneyEventID)
		var attemptJourneyID pgtype.UUID
		if err := tx.QueryRow(ctx, `select event_id from observability_journey_events where journey_id=$1 and parent_event_id=$2 and name='webhook.delivery.attempt_started' order by sequence desc limit 1`, value.journeyID, value.queuedJourneyEventID).Scan(&attemptJourneyID); err == nil {
			parentID = id(attemptJourneyID)
		} else if err != pgx.ErrNoRows {
			return err
		}
		if err := insertWebhookJourneyEvent(ctx, tx, terminalID, id(value.journeyID), int64(3+int(value.attemptNumber)*2), "webhook.delivery.cancelled", "cancelled", parentID, "", "", map[string]any{"delivery_id": id(value.deliveryID).String(), "reason": reason}); err != nil {
			return err
		}
		if canceledCount != nil {
			*canceledCount = *canceledCount + 1
		}
	}
	return nil
}

func valueOrZero(value *int32) int32 {
	if value == nil {
		return 0
	}
	return *value
}
