defmodule ChalkSync.Stateholder.Postgres.SQL.PublicationGrants do
  @moduledoc false

  def select_publication_grant_reservation do
    """
    select reservation_id, operation_id, participant_id,
      participant_generation, source, status, failure_code, expires_at
    from sync_publication_grant_reservations
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and operation_id = $4
    """
  end

  def lock_publication_grant_reservation do
    read_publication_grant_reservation() <> " for update"
  end

  def read_publication_grant_reservation do
    """
    select reservation_id, operation_id, participant_id,
      participant_generation, source, status, failure_code, expires_at
    from sync_publication_grant_reservations
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and reservation_id = $4
    """
  end

  def insert_publication_grant_reservation do
    """
    insert into sync_publication_grant_reservations (
      tenant_id, space_id, episode_id, reservation_id, operation_id,
      participant_id, participant_generation, source, expires_at, answered_stop_revision
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '30 seconds', (
      select revision from sync_media_stops
      where tenant_id = $1 and episode_id = $3 and participant_id = $6 and source = $8
    ))
    on conflict (tenant_id, episode_id, participant_id, source)
      where status in ('pending', 'ambiguous') do update
    set space_id = excluded.space_id, reservation_id = excluded.reservation_id,
      operation_id = excluded.operation_id,
      participant_generation = excluded.participant_generation,
      status = 'pending', failure_code = null,
      expires_at = excluded.expires_at, created_at = now(), completed_at = null,
      answered_stop_revision = excluded.answered_stop_revision
    where sync_publication_grant_reservations.expires_at <= now()
    returning reservation_id, operation_id, participant_id,
      participant_generation, source, status, failure_code, expires_at
    """
  end

  def complete_publication_grant_reservation do
    """
    update sync_publication_grant_reservations
    set status = $5, failure_code = $6,
      completed_at = case when $5 in ('confirmed', 'failed') then now() else null end,
      expires_at = greatest(expires_at, now() + interval '5 minutes')
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and reservation_id = $4 and status in ('pending', 'ambiguous')
    returning reservation_id, operation_id, participant_id,
      participant_generation, source, status, failure_code, expires_at
    """
  end

  # The on answers the host stop that stood when its reservation was made, and only that one: a stop committed
  # after the reservation has a newer revision and stays.
  def clear_answered_stop do
    """
    delete from sync_media_stops stop
    using sync_publication_grant_reservations reservation
    where reservation.tenant_id = $1 and reservation.space_id = $2 and reservation.episode_id = $3
      and reservation.reservation_id = $4
      and stop.tenant_id = reservation.tenant_id and stop.episode_id = reservation.episode_id
      and stop.participant_id = reservation.participant_id and stop.source = reservation.source
      and stop.revision <= reservation.answered_stop_revision
    """
  end

  def publication_fence do
    """
    select external_operation_id
    from sync_publication_fences
    where tenant_id = $1 and episode_id = $2 and participant_id = $3
      and participant_generation = $4 and source = $5 and expires_at > now()
    for update
    """
  end

  def count_publication_grant_reservations do
    """
    select count(*)
    from sync_publication_grant_reservations
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and expires_at > now()
    """
  end

  def pending_role_transition_child_for_source do
    """
    select external_operation_id
    from sync_external_operations
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and operation_name = 'role_transition_source_stop' and status = 'pending'
      and target_participant_id = $4 and target_participant_generation = $5
      and source = $6
    order by created_at, external_operation_id
    for update
    limit 1
    """
  end
end
