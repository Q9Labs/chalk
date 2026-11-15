defmodule ChalkSync.Retention.DeadlineSQL do
  @moduledoc false

  def first_deadline_generation do
    """
    select payload -> 'deadline_generation'
    from sync_control_events
    where tenant_id = $1
      and episode_id = $2
      and event_name = 'deadline_changed'
    order by revision
    limit 1
    """
  end
end
