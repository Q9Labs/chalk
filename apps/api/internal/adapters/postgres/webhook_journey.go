package postgres

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func insertWebhookJourneyEvent(ctx context.Context, tx pgx.Tx, eventID, journeyID utilities.ID, sequence int64, name, state string, parentID utilities.ID, traceID, spanID string, attributes map[string]any) error {
	body, err := json.Marshal(attributes)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,parent_event_id,trace_id,span_id,attributes) values($1,$2,$3,$4,$5,$6,$7,'server','api','visible',$8,$9,$10,$11) on conflict(event_id) do nothing`, uuid(eventID), uuid(journeyID), sequence, time.Now().UTC(), name, webhookJourneyPhase(state), state, uuid(parentID), optionalText(traceID), optionalText(spanID), body)
	return err
}

func webhookJourneyPhase(state string) string {
	switch state {
	case "succeeded", "exhausted", "cancelled", "erased":
		return "terminal"
	default:
		return "webhook"
	}
}

func insertWebhookAPIRootJourneyEvent(ctx context.Context, tx pgx.Tx, eventID, journeyID utilities.ID, name, traceID, spanID string) error {
	return insertWebhookOperationRoot(ctx, tx, eventID, journeyID, "api."+name+".requested", traceID, spanID, map[string]any{"event_name": name})
}

func insertWebhookOperationRoot(ctx context.Context, tx pgx.Tx, eventID, journeyID utilities.ID, name, traceID, spanID string, attributes map[string]any) error {
	body, err := json.Marshal(attributes)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,trace_id,span_id,attributes) values($1,$2,0,$3,$4,'api_request','accepted','server','api','visible',$5,$6,$7) on conflict(event_id) do nothing`, uuid(eventID), uuid(journeyID), time.Now().UTC(), name, optionalText(traceID), optionalText(spanID), body)
	return err
}
