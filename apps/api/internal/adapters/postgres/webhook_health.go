package postgres

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

// Health reports dispatcher/backlog health for metrics and alerts only. It is
// intentionally separate from API and Sync readiness: receiver outages and a
// webhook backlog must never make the meeting control plane unready.
func (r WebhookDispatchRepository) Health(ctx context.Context) (webhooks.HealthSnapshot, error) {
	var result webhooks.HealthSnapshot
	var oldestEligibleSeconds, cleanupLagSeconds, journeyAgeSeconds float64
	err := r.pool.QueryRow(ctx, `
with delivery_counts as (
  select
    count(*) filter (where state='pending') as pending,
    count(*) filter (where state='retry_wait') as retry_wait,
    count(*) filter (where state='delivering') as leased,
    coalesce(max(extract(epoch from (now()-next_attempt_at))) filter (
      where state in ('pending','retry_wait') and next_attempt_at<=now()
    ),0) as oldest_eligible_seconds
  from webhook_deliveries
), tenant_active as (
  select tenant_id,count(*) as active from webhook_deliveries
  where state='delivering' group by tenant_id
), endpoint_active as (
  select tenant_id,endpoint_id,count(*) as active from webhook_deliveries
  where state='delivering' group by tenant_id,endpoint_id
), eligible as (
  select d.tenant_id,d.endpoint_id,coalesce(t.active,0) as tenant_active,coalesce(e.active,0) as endpoint_active
  from webhook_deliveries d
  left join tenant_active t on t.tenant_id=d.tenant_id
  left join endpoint_active e on e.tenant_id=d.tenant_id and e.endpoint_id=d.endpoint_id
  where d.state in ('pending','retry_wait') and d.next_attempt_at<=now() and d.attempt_count<11
), fairness as (
  select
    count(*) filter (where endpoint_active>=4) as endpoint_throttled,
    count(*) filter (where tenant_active>=20) as tenant_throttled
  from eligible
), retention as (
  select coalesce(max(extract(epoch from (now()-(occurred_at+interval '30 days')))),0) as cleanup_lag_seconds
  from webhook_events where occurred_at<now()-interval '30 days'
), journeys as (
  select coalesce(max(extract(epoch from (now()-e.occurred_at))),0) as oldest_unterminated_seconds
  from webhook_deliveries d join webhook_events e on e.tenant_id=d.tenant_id and e.id=d.event_id
  where d.terminal_journey_event_id is null
)
select d.pending,d.retry_wait,d.leased,d.oldest_eligible_seconds,
       f.endpoint_throttled,f.tenant_throttled,r.cleanup_lag_seconds,j.oldest_unterminated_seconds
from delivery_counts d cross join fairness f cross join retention r cross join journeys j
`).Scan(
		&result.PendingDeliveries,
		&result.RetryWaitDeliveries,
		&result.LeasedDeliveries,
		&oldestEligibleSeconds,
		&result.EndpointFairnessThrottles,
		&result.TenantFairnessThrottles,
		&cleanupLagSeconds,
		&journeyAgeSeconds,
	)
	if err != nil {
		return webhooks.HealthSnapshot{}, err
	}
	result.OldestEligibleAge = secondsDuration(oldestEligibleSeconds)
	result.CleanupLag = secondsDuration(cleanupLagSeconds)
	result.OldestUnterminatedAge = secondsDuration(journeyAgeSeconds)
	return result, nil
}

func secondsDuration(seconds float64) time.Duration {
	if seconds <= 0 {
		return 0
	}
	return time.Duration(seconds * float64(time.Second))
}

var _ webhooks.DispatchHealthRepository = WebhookDispatchRepository{}
