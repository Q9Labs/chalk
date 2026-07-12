\set ON_ERROR_STOP on
\set tenant_id '10000000-0000-4000-8000-000000000001'
\set room_id '10000000-0000-4000-8000-000000000002'
\set session_id '10000000-0000-4000-8000-000000000003'

begin;
set local synchronous_commit = off;

insert into tenants (id, name)
values (:'tenant_id', 'Sync launch-cardinality fixture');

insert into rooms (id, name, tenant_id, status, slug, media_plane)
values (:'room_id', 'Sync launch-cardinality fixture', :'tenant_id', 'active', 'sync-launch-cardinality-fixture', 'cf_rtk');

insert into room_sessions (id, status, room_id, tenant_id, started_at)
values (:'session_id', 'active', :'room_id', :'tenant_id', now());

insert into participants (
    id,
    name,
    capabilities,
    tenant_id,
    room_id,
    session_id,
    generation,
    status,
    joined_at
)
select
    md5('sync-launch-participant:' || ordinal::text)::uuid,
    'Launch participant ' || ordinal::text,
    array['control:hand'],
    :'tenant_id',
    :'room_id',
    :'session_id',
    1,
    'active',
    now()
from generate_series(1, :participant_count) as ordinal;

insert into sync_session_control (
    tenant_id,
    room_id,
    session_id,
    control_revision,
    folded_state,
    state_schema_version,
    state_digest,
    snapshot_bytes,
    participant_event_count,
    participant_event_bytes,
    receipt_count,
    receipt_bytes
) values (
    :'tenant_id',
    :'room_id',
    :'session_id',
    :event_count,
    jsonb_build_object(
        'control_revision', :event_count,
        'participants', '[]'::jsonb,
        'state_schema_version', 1,
        'status', 'active'
    ),
    1,
    decode(repeat('00', 32), 'hex'),
    192,
    :event_count,
    :event_count * 256,
    :receipt_count,
    :receipt_count * 256
);

insert into sync_control_events (
    tenant_id,
    room_id,
    session_id,
    event_id,
    base_revision,
    revision,
    event_name,
    payload,
    actor_participant_session_id,
    actor_generation,
    command_id,
    event_schema_version,
    resulting_state_digest,
    encoded_bytes
)
select
    :'tenant_id',
    :'room_id',
    :'session_id',
    md5('sync-launch-event:' || revision::text)::uuid,
    revision - 1,
    revision,
    case when revision % 2 = 0 then 'hand_lowered' else 'hand_raised' end,
    jsonb_build_object(
        'participant_session_id',
        md5('sync-launch-participant:' || (((revision - 1) % :participant_count) + 1)::text)::uuid::text
    ),
    md5('sync-launch-participant:' || (((revision - 1) % :participant_count) + 1)::text)::uuid,
    1,
    'command_' || lpad(revision::text, 16, '0'),
    1,
    decode(md5('sync-launch-digest-a:' || revision::text) || md5('sync-launch-digest-b:' || revision::text), 'hex'),
    256
from generate_series(1, :event_count) as revision;

insert into sync_command_receipts (
    tenant_id,
    session_id,
    participant_session_id,
    submitted_generation,
    command_id,
    request_fingerprint,
    command_name,
    outcome,
    event_id,
    resulting_revision
)
select
    :'tenant_id',
    :'session_id',
    md5('sync-launch-participant:' || (((revision - 1) % :participant_count) + 1)::text)::uuid,
    1,
    'command_' || lpad(revision::text, 16, '0'),
    decode(md5('sync-launch-request-a:' || revision::text) || md5('sync-launch-request-b:' || revision::text), 'hex'),
    case when revision % 2 = 0 then 'lower_hand' else 'raise_hand' end,
    'committed',
    md5('sync-launch-event:' || revision::text)::uuid,
    revision
from generate_series(1, :event_count) as revision;

insert into sync_command_receipts (
    tenant_id,
    session_id,
    participant_session_id,
    submitted_generation,
    command_id,
    request_fingerprint,
    command_name,
    outcome,
    rejection_reason
)
select
    :'tenant_id',
    :'session_id',
    md5('sync-launch-participant:' || (((ordinal - 1) % :participant_count) + 1)::text)::uuid,
    1,
    'rejected_' || lpad(ordinal::text, 16, '0'),
    decode(md5('sync-launch-rejected-a:' || ordinal::text) || md5('sync-launch-rejected-b:' || ordinal::text), 'hex'),
    'raise_hand',
    'rejected',
    'invalid_state'
from generate_series(1, :receipt_count - :event_count) as ordinal;

analyze participants;
analyze sync_session_control;
analyze sync_control_events;
analyze sync_command_receipts;

create function pg_temp.assert_index(query text, expected_index text)
returns void
language plpgsql
as $$
declare
    plan json;
begin
    execute 'explain (format json) ' || query into plan;
    if position(expected_index in plan::text) = 0 then
        raise exception 'expected index % was absent from plan: %', expected_index, plan;
    end if;
end;
$$;

select pg_temp.assert_index(
    $query$
    select receipt.outcome, receipt.event_id, receipt.resulting_revision
    from sync_command_receipts receipt
    join sync_session_control control
      on control.tenant_id = receipt.tenant_id
      and control.session_id = receipt.session_id
    where receipt.tenant_id = '10000000-0000-4000-8000-000000000001'
      and control.room_id = '10000000-0000-4000-8000-000000000002'
      and receipt.session_id = '10000000-0000-4000-8000-000000000003'
      and receipt.participant_session_id = md5('sync-launch-participant:1')::uuid
      and receipt.command_id = 'command_0000000000000001'
    $query$,
    'sync_command_receipts_pkey'
);

select pg_temp.assert_index(
    $query$
    select revision, event_name, payload, resulting_state_digest
    from sync_control_events
    where tenant_id = '10000000-0000-4000-8000-000000000001'
      and session_id = '10000000-0000-4000-8000-000000000003'
      and revision > 247951
    order by revision
    limit 2049
    $query$,
    'sync_control_events_pkey'
);

\echo 'Decision receipt plan'
explain (analyze, buffers, costs off, timing off)
select receipt.outcome, receipt.event_id, receipt.resulting_revision
from sync_command_receipts receipt
join sync_session_control control
  on control.tenant_id = receipt.tenant_id
  and control.session_id = receipt.session_id
where receipt.tenant_id = :'tenant_id'
  and control.room_id = :'room_id'
  and receipt.session_id = :'session_id'
  and receipt.participant_session_id = md5('sync-launch-participant:1')::uuid
  and receipt.command_id = 'command_0000000000000001';

\echo 'Recovery suffix plan'
explain (analyze, buffers, costs off, timing off)
select revision, event_name, payload, resulting_state_digest
from sync_control_events
where tenant_id = :'tenant_id'
  and session_id = :'session_id'
  and revision > :event_count - 2049
order by revision
limit 2049;

rollback;
