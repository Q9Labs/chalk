defmodule ChalkSync.Operations.Probe.Database.Queries do
  @moduledoc """
  SQL and parameters of the database readiness reads.
  """

  def role_query do
    """
    select
      pg_is_in_recovery(),
      current_setting('synchronous_commit'),
      current_setting('synchronous_standby_names'),
      current_setting('server_version_num')::integer,
      current_setting('fsync'),
      current_setting('full_page_writes'),
      current_setting('data_checksums')
    """
  end

  def migration_query do
    """
    select coalesce(max(version_id), 0)
    from (
      select distinct on (version_id) version_id, is_applied
      from goose_db_version
      order by version_id, id desc
    ) latest
    where is_applied
    """
  end

  def pending_age_query do
    """
    with pending_intents as (
      select lifecycle_intent_id, intent_name, next_attempt_at, attempt_count, last_error_code,
        case
          when intent_name = 'participant_joined' and attempt_count = 0
            then nullif(next_attempt_at, 'infinity'::timestamptz)
          else created_at
        end as lag_since
      from sync_lifecycle_intents
      where status = 'pending'
    )
    select
      pending.oldest_age_ms,
      (
        select coalesce(
          (extract(epoch from (now() - min(episode.ended_at) - interval '7 days')) * 1000)::bigint,
          0
        )
        from episodes episode
        join sync_episode_control control
          on control.tenant_id = episode.tenant_id
          and control.space_id = episode.space_id
          and control.episode_id = episode.id
        where episode.status = 'ended'
          and episode.ended_at <= now() - interval '7 days'
          and control.retention_cleaned_at is null
      ),
      pending.total, pending.due, pending.retrying,
      oldest.attempt_count, oldest.last_error_code,
      oldest_due.lifecycle_intent_id, oldest_due.intent_name,
      oldest_due.next_attempt_at, oldest_due.attempt_count
    from (
      select
        greatest((extract(epoch from (now() - min(lag_since))) * 1000)::bigint, 0)
          as oldest_age_ms,
        count(*) as total,
        count(*) filter (where next_attempt_at <= now()) as due,
        count(*) filter (where attempt_count > 0) as retrying
      from pending_intents
    ) pending
    left join lateral (
      select attempt_count, last_error_code
      from pending_intents
      where lag_since <= now()
      order by lag_since, lifecycle_intent_id
      limit 1
    ) oldest on true
    left join lateral (
      select lifecycle_intent_id, intent_name, next_attempt_at, attempt_count
      from pending_intents
      where next_attempt_at <= now()
      order by next_attempt_at, lifecycle_intent_id
      limit 1
    ) oldest_due on true
    """
  end

  def replication_query do
    """
    select
      count(*)::bigint,
      coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)), 0)::bigint
    from pg_stat_replication
    where state = 'streaming' and sync_state in ('sync', 'quorum')
    """
  end
end
