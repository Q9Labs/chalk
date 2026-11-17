defmodule ChalkSync.Stateholder.Postgres.SQL.RecordingReservation do
  @moduledoc false

  # A recording runs until the Episode's deadline, so a later deadline moves the end of its
  # reservation, which the recorder follows. The reservation never ends earlier than it did
  # (an earlier deadline ends the Episode, and that ends the recording) and never runs past
  # the recording limit counted from the recording's start.
  def move do
    """
    with target as (
      select id,
             least(
               to_timestamp($4::double precision / 1000.0),
               coalesce(starts_at, created_at) + make_interval(secs => $5::integer)
             ) as new_ends_at
      from recording_reservations
      where tenant_id = $1 and space_id = $2 and episode_id = $3 and state = 'reserved'
    )
    update recording_reservations reservations
    set ends_at = target.new_ends_at,
        max_duration_seconds = least(
          $5::integer,
          ceil(extract(epoch from target.new_ends_at - coalesce(reservations.starts_at, reservations.created_at)))::integer
        ),
        updated_at = now()
    from target
    where reservations.id = target.id and reservations.ends_at < target.new_ends_at
    """
  end
end
