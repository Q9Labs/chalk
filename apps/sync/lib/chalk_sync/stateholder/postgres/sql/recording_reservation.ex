defmodule ChalkSync.Stateholder.Postgres.SQL.RecordingReservation do
  @moduledoc false

  # A recording runs until the Episode's deadline, so a later deadline moves the end of its
  # reservation, which the recorder follows. It runs when a deadline moves and when a recording
  # start creates its reservation, so a start that overlaps an extension still follows it. The
  # reservation never ends earlier than it did (an earlier deadline ends the Episode, and that
  # ends the recording) and never runs past the recording limit counted from the recording's start.
  # $1 to $3 name the Episode, $4 is the recording limit in seconds.
  def move do
    """
    with target as (
      select reservations.id as id,
             least(
               episodes.deadline_at,
               coalesce(starts_at, reservations.created_at) + make_interval(secs => $4::integer)
             ) as new_ends_at
      from recording_reservations reservations
      join episodes on episodes.id = reservations.episode_id
      where reservations.tenant_id = $1 and reservations.space_id = $2 and reservations.episode_id = $3
        and reservations.state = 'reserved'
    )
    update recording_reservations reservations
    set ends_at = target.new_ends_at,
        max_duration_seconds = least(
          $4::integer,
          ceil(extract(epoch from target.new_ends_at - coalesce(reservations.starts_at, reservations.created_at)))::integer
        ),
        updated_at = now()
    from target
    where reservations.id = target.id and reservations.ends_at < target.new_ends_at
    """
  end
end
