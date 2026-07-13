-- name: EnsureWebhookTenantState :exec
insert into webhook_tenant_state (tenant_id)
values (sqlc.arg(tenant_id))
on conflict (tenant_id) do nothing;

-- name: LockWebhookTenantState :exec
select tenant_id
from webhook_tenant_state
where tenant_id = sqlc.arg(tenant_id)
for update;

-- name: CountWebhookEndpoints :one
select count(*)::integer
from webhook_endpoints
where tenant_id = sqlc.arg(tenant_id) and deleted_at is null;

-- name: InsertWebhookEndpoint :one
insert into webhook_endpoints (
    id, tenant_id, name, enabled, revision, current_target_revision,
    current_secret_ciphertext, created_by_user_id
) values (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(name), sqlc.arg(enabled), 1, 1,
    sqlc.arg(current_secret_ciphertext), sqlc.narg(created_by_user_id)
)
returning *;

-- name: InsertWebhookEndpointRevision :one
insert into webhook_endpoint_revisions (
    id, tenant_id, endpoint_id, revision, url_ciphertext, url_redacted, api_version, event_types
) values (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(endpoint_id), sqlc.arg(revision),
    sqlc.arg(url_ciphertext), sqlc.arg(url_redacted), sqlc.arg(api_version), sqlc.arg(event_types)
)
returning *;

-- name: GetWebhookEndpoint :one
select e.*, r.id as target_revision_id, r.url_redacted, r.url_ciphertext, r.api_version, r.event_types
from webhook_endpoints e
join webhook_endpoint_revisions r
  on r.tenant_id = e.tenant_id and r.endpoint_id = e.id and r.revision = e.current_target_revision
where e.tenant_id = sqlc.arg(tenant_id) and e.id = sqlc.arg(endpoint_id) and e.deleted_at is null;

-- name: ListWebhookEndpoints :many
select e.*, r.url_redacted, r.api_version, r.event_types
from webhook_endpoints e
join webhook_endpoint_revisions r
  on r.tenant_id = e.tenant_id and r.endpoint_id = e.id and r.revision = e.current_target_revision
where e.tenant_id = sqlc.arg(tenant_id) and e.deleted_at is null
  and (not sqlc.arg(cursor_set)::boolean or (e.created_at, e.id) < (sqlc.arg(cursor_created_at)::timestamptz, sqlc.arg(cursor_id)::uuid))
order by e.created_at desc, e.id desc
limit sqlc.arg(page_size)::integer;

-- name: UpdateWebhookEndpoint :one
update webhook_endpoints
set name = sqlc.arg(name), enabled = sqlc.arg(enabled), revision = revision + 1,
    current_target_revision = sqlc.arg(current_target_revision), updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(endpoint_id)
  and revision = sqlc.arg(expected_revision) and deleted_at is null
returning *;

-- name: CancelWebhookDeliveriesForOldTarget :execrows
update webhook_deliveries
set state = 'canceled', next_attempt_at = null, terminal_at = now(), updated_at = now(),
    lease_token = null, lease_owner = null, lease_expires_at = null
where tenant_id = sqlc.arg(tenant_id) and endpoint_id = sqlc.arg(endpoint_id)
  and endpoint_revision <> sqlc.arg(current_target_revision)
  and state in ('pending', 'retry_wait', 'delivering');

-- name: DestroyOldWebhookTargetURLs :execrows
update webhook_endpoint_revisions
set url_ciphertext = null, url_destroyed_at = now()
where tenant_id = sqlc.arg(tenant_id) and endpoint_id = sqlc.arg(endpoint_id)
  and revision <> sqlc.arg(current_target_revision) and url_ciphertext is not null;

-- name: DeleteWebhookEndpoint :one
update webhook_endpoints
set enabled = false, revision = revision + 1, current_secret_ciphertext = null,
    previous_secret_ciphertext = null, previous_secret_expires_at = null,
    deleted_at = now(), updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(endpoint_id)
  and revision = sqlc.arg(expected_revision) and deleted_at is null
returning id;

-- name: CancelWebhookEndpointDeliveries :execrows
update webhook_deliveries
set state = 'canceled', next_attempt_at = null, terminal_at = now(), updated_at = now(),
    lease_token = null, lease_owner = null, lease_expires_at = null
where tenant_id = sqlc.arg(tenant_id) and endpoint_id = sqlc.arg(endpoint_id)
  and state in ('pending', 'retry_wait', 'delivering');

-- name: DestroyWebhookEndpointURLs :execrows
update webhook_endpoint_revisions
set url_ciphertext = null, url_destroyed_at = now()
where tenant_id = sqlc.arg(tenant_id) and endpoint_id = sqlc.arg(endpoint_id)
  and url_ciphertext is not null;

-- name: RotateWebhookEndpointSecret :one
update webhook_endpoints
set previous_secret_ciphertext = case when sqlc.arg(revoke_previous)::boolean then null else current_secret_ciphertext end,
    previous_secret_expires_at = case when sqlc.arg(revoke_previous)::boolean then null else now() + interval '24 hours' end,
    current_secret_ciphertext = sqlc.arg(current_secret_ciphertext), updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(endpoint_id) and deleted_at is null
returning id, revision, previous_secret_expires_at;

-- name: InsertWebhookEvent :one
insert into webhook_events (
    id, tenant_id, event_name, api_version, occurred_at, body, body_sha256,
    semantic_transition_key, resource_type, resource_id, linked_user_id,
    journey_id, parent_journey_event_id, producing_trace_id, producing_span_id
) values (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(event_name), sqlc.arg(api_version),
    sqlc.arg(occurred_at), sqlc.arg(body), sqlc.arg(body_sha256), sqlc.arg(semantic_transition_key),
    sqlc.arg(resource_type), sqlc.arg(resource_id), sqlc.narg(linked_user_id),
    sqlc.arg(journey_id), sqlc.narg(parent_journey_event_id), sqlc.narg(producing_trace_id), sqlc.narg(producing_span_id)
)
on conflict (tenant_id, semantic_transition_key, api_version) do nothing
returning *;

-- name: ListMatchingWebhookTargets :many
select e.id as endpoint_id, r.id as endpoint_revision_id, r.revision
from webhook_endpoints e
join webhook_endpoint_revisions r
  on r.tenant_id = e.tenant_id and r.endpoint_id = e.id and r.revision = e.current_target_revision
where e.tenant_id = sqlc.arg(tenant_id) and e.enabled and e.deleted_at is null
  and r.api_version = sqlc.arg(api_version) and sqlc.arg(event_name)::text = any(r.event_types)
order by e.created_at, e.id;

-- name: InsertWebhookDelivery :one
insert into webhook_deliveries (
    id, tenant_id, event_id, endpoint_id, endpoint_revision_id, endpoint_revision,
    state, next_attempt_at, queued_journey_event_id, parent_delivery_id
) values (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(event_id), sqlc.arg(endpoint_id),
    sqlc.arg(endpoint_revision_id), sqlc.arg(endpoint_revision), 'pending',
    sqlc.arg(next_attempt_at), sqlc.arg(queued_journey_event_id), sqlc.narg(parent_delivery_id)
)
returning *;

-- name: ListWebhookDeliveries :many
select d.*, e.event_name
from webhook_deliveries d join webhook_events e
  on e.tenant_id = d.tenant_id and e.id = d.event_id
where d.tenant_id = sqlc.arg(tenant_id) and d.endpoint_id = sqlc.arg(endpoint_id)
  and (coalesce(cardinality(sqlc.arg(states)::text[]), 0) = 0 or d.state = any(sqlc.arg(states)::text[]))
  and (coalesce(cardinality(sqlc.arg(event_types)::text[]), 0) = 0 or e.event_name = any(sqlc.arg(event_types)::text[]))
  and (not sqlc.arg(cursor_set)::boolean or (d.created_at, d.id) < (sqlc.arg(cursor_created_at)::timestamptz, sqlc.arg(cursor_id)::uuid))
order by d.created_at desc, d.id desc
limit sqlc.arg(page_size)::integer;

-- name: GetWebhookDelivery :one
select d.*, e.event_name, e.api_version, e.body, e.erased_at, e.journey_id, e.occurred_at
from webhook_deliveries d join webhook_events e
  on e.tenant_id = d.tenant_id and e.id = d.event_id
where d.tenant_id = sqlc.arg(tenant_id) and d.endpoint_id = sqlc.arg(endpoint_id) and d.id = sqlc.arg(delivery_id);

-- name: ListWebhookDeliveryAttempts :many
select * from webhook_delivery_attempts
where tenant_id = sqlc.arg(tenant_id) and delivery_id = sqlc.arg(delivery_id)
order by attempt_number;

-- name: ClaimWebhookDeliveries :many
with endpoint_ranked as (
    select d.tenant_id, d.id, d.endpoint_id,
      row_number() over (partition by d.tenant_id, d.endpoint_id order by d.next_attempt_at, d.created_at, d.id) as endpoint_rank,
      (select count(*) from webhook_deliveries x where x.tenant_id = d.tenant_id and x.endpoint_id = d.endpoint_id and x.state = 'delivering') as endpoint_active
    from webhook_deliveries d
    where d.state in ('pending', 'retry_wait') and d.next_attempt_at <= now()
      and d.attempt_count < 11
), endpoint_eligible as (
    select * from endpoint_ranked where endpoint_rank <= 4-endpoint_active
), tenant_candidates as (
    select e.tenant_id, s.updated_at as tenant_last_claimed_at
    from endpoint_eligible e join webhook_tenant_state s on s.tenant_id=e.tenant_id
    group by e.tenant_id, s.updated_at
    order by s.updated_at, e.tenant_id
    limit sqlc.arg(batch_size)::integer
), ranked as (
    select e.*, t.tenant_last_claimed_at,
      row_number() over (partition by e.tenant_id order by d.next_attempt_at, d.created_at, d.id) as tenant_rank,
      (select count(*) from webhook_deliveries x where x.tenant_id = e.tenant_id and x.state = 'delivering') as tenant_active
    from tenant_candidates t
    join endpoint_eligible e on e.tenant_id=t.tenant_id
    join webhook_deliveries d on d.tenant_id=e.tenant_id and d.id=e.id
), candidates as (
    select d.tenant_id, d.id
    from ranked r join webhook_deliveries d on d.tenant_id=r.tenant_id and d.id=r.id
    where r.tenant_rank <= 20-r.tenant_active
      and pg_try_advisory_xact_lock(hashtextextended(r.tenant_id::text, 0))
    order by r.tenant_rank, r.tenant_last_claimed_at, d.next_attempt_at, d.tenant_id, d.endpoint_id, d.created_at
    for update of d skip locked
    limit sqlc.arg(batch_size)::integer
), touched_tenants as (
    update webhook_tenant_state s set updated_at=clock_timestamp()
    where s.tenant_id in (select distinct c.tenant_id from candidates c)
    returning s.tenant_id
)
update webhook_deliveries d
set state = 'delivering', next_attempt_at = null, attempt_count = attempt_count + 1,
    lease_token = sqlc.arg(lease_token), lease_owner = sqlc.arg(lease_owner),
    lease_expires_at = now()+make_interval(secs => sqlc.arg(lease_duration_seconds)::integer), updated_at = now()
from candidates c
where d.tenant_id = c.tenant_id and d.id = c.id
  and exists (select 1 from touched_tenants t where t.tenant_id=c.tenant_id)
returning d.*;

-- name: EraseWebhookEventsForUser :execrows
with erased as (
    update webhook_events set body = null, erased_at = now()
    where linked_user_id = sqlc.arg(user_id) and erased_at is null
    returning tenant_id, id
)
update webhook_deliveries d
set state = 'erased', next_attempt_at = null, terminal_at = now(), updated_at = now(),
    lease_token = null, lease_owner = null, lease_expires_at = null
from erased e
where d.tenant_id = e.tenant_id and d.event_id = e.id and d.state in ('pending', 'retry_wait', 'delivering');

-- name: CleanupExpiredWebhookAttempts :execrows
with expired as (
    select a.tenant_id, a.id from webhook_delivery_attempts a join webhook_deliveries d
      on d.tenant_id=a.tenant_id and d.id=a.delivery_id join webhook_events e
      on e.tenant_id=d.tenant_id and e.id=d.event_id
    where e.occurred_at < now() - interval '30 days' order by e.occurred_at limit 1000
)
delete from webhook_delivery_attempts a using expired x where a.tenant_id=x.tenant_id and a.id=x.id;

-- name: CleanupExpiredWebhookDeliveries :execrows
with expired as (
    select d.tenant_id,d.id from webhook_deliveries d join webhook_events e
      on e.tenant_id=d.tenant_id and e.id=d.event_id
    where e.occurred_at < now() - interval '30 days' and not exists (
      select 1 from webhook_delivery_attempts a where a.tenant_id=d.tenant_id and a.delivery_id=d.id
    ) order by e.occurred_at limit 1000
)
delete from webhook_deliveries d using expired x where d.tenant_id=x.tenant_id and d.id=x.id;

-- name: CleanupExpiredWebhookEvents :execrows
with expired as (
    select e.tenant_id,e.id from webhook_events e where e.occurred_at < now()-interval '30 days'
      and not exists(select 1 from webhook_deliveries d where d.tenant_id=e.tenant_id and d.event_id=e.id)
    order by e.occurred_at limit 1000
)
delete from webhook_events e using expired x where e.tenant_id=x.tenant_id and e.id=x.id;

-- name: CleanupExpiredWebhookIdempotency :execrows
update webhook_idempotency_records set response_ciphertext=null where ctid in (
  select ctid from webhook_idempotency_records
  where expires_at < now() and response_ciphertext is not null
  order by expires_at limit 1000
);

-- name: CleanupExpiredWebhookPreviousSecrets :execrows
update webhook_endpoints set previous_secret_ciphertext=null,previous_secret_expires_at=null,updated_at=now()
where ctid in (
  select ctid from webhook_endpoints
  where previous_secret_expires_at<=now() and previous_secret_ciphertext is not null
  order by previous_secret_expires_at limit 1000
);

-- name: CleanupDeletedWebhookEndpoints :execrows
delete from webhook_endpoints where ctid in (
  select e.ctid from webhook_endpoints e
  where e.deleted_at<now()-interval '30 days'
    and not exists (select 1 from webhook_deliveries d where d.tenant_id=e.tenant_id and d.endpoint_id=e.id)
  order by e.deleted_at limit 1000
);

-- name: CountOrphanWebhookJourneyParents :one
select count(*) from (
  select e.journey_id,e.parent_journey_event_id
  from webhook_events e where e.parent_journey_event_id is not null
  union all
  select i.journey_id,i.parent_journey_event_id
  from sync_lifecycle_intents i where i.parent_journey_event_id is not null
) child
where not exists (
  select 1 from observability_journey_events parent
  where parent.event_id=child.parent_journey_event_id and parent.journey_id=child.journey_id
);
