package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func fenceWebhookDeliveriesForSecretRotation(ctx context.Context, tx pgx.Tx, tenantID, endpointID utilities.ID) error {
	rows, err := tx.Query(ctx, `select d.id,d.queued_journey_event_id,d.attempt_count,q.journey_id from webhook_deliveries d join observability_journey_events q on q.event_id=d.queued_journey_event_id where d.tenant_id=$1 and d.endpoint_id=$2 and d.state='delivering' order by d.created_at for update of d`, uuid(tenantID), uuid(endpointID))
	if err != nil {
		return err
	}
	type claimedDelivery struct {
		deliveryID, queuedJourneyEventID, journeyID pgtype.UUID
		attemptNumber                               int32
	}
	var deliveries []claimedDelivery
	for rows.Next() {
		var delivery claimedDelivery
		if err := rows.Scan(&delivery.deliveryID, &delivery.queuedJourneyEventID, &delivery.attemptNumber, &delivery.journeyID); err != nil {
			rows.Close()
			return err
		}
		deliveries = append(deliveries, delivery)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, delivery := range deliveries {
		branchID, err := utilities.NewID()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update webhook_deliveries set state='retry_wait',next_attempt_at=now(),terminal_at=null,terminal_journey_event_id=null,lease_token=null,lease_owner=null,lease_expires_at=null,updated_at=now() where tenant_id=$1 and id=$2 and state='delivering'`, uuid(tenantID), delivery.deliveryID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update webhook_delivery_attempts set outcome='retryable_failure',finished_at=now(),latency_milliseconds=greatest(0,extract(epoch from (now()-started_at))*1000)::integer,error_code='secret_rotated' where tenant_id=$1 and delivery_id=$2 and attempt_number=$3 and outcome='started'`, uuid(tenantID), delivery.deliveryID, delivery.attemptNumber); err != nil {
			return err
		}
		parentID := id(delivery.queuedJourneyEventID)
		var attemptJourneyID pgtype.UUID
		if err := tx.QueryRow(ctx, `select event_id from observability_journey_events where journey_id=$1 and name='webhook.delivery.attempt_started' and attributes->>'delivery_id'=$2 and (attributes->>'attempt_number')::integer=$3 order by sequence desc limit 1`, delivery.journeyID, id(delivery.deliveryID).String(), delivery.attemptNumber).Scan(&attemptJourneyID); err == nil {
			parentID = id(attemptJourneyID)
		} else if err != pgx.ErrNoRows {
			return err
		}
		if err := insertWebhookJourneyEvent(ctx, tx, branchID, id(delivery.journeyID), int64(3+int(delivery.attemptNumber)*2), "webhook.delivery.retry_scheduled", "retry_wait", parentID, "", "", map[string]any{"attempt_number": delivery.attemptNumber, "delivery_id": id(delivery.deliveryID).String(), "error_code": "secret_rotated", "status_class": "none"}); err != nil {
			return err
		}
	}
	return nil
}
