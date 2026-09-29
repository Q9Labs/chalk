defmodule ChalkSync.Stateholder.Postgres.SQL.MediaPauses do
  @moduledoc false

  def list do
    """
    select participant_id, source, publication_id
    from sync_media_pauses
    where tenant_id = $1 and space_id = $2 and episode_id = $3
    order by participant_id, source
    limit 1001
    """
  end

  def lock_authority do
    """
    select episode.status, participant.status
    from sync_episode_control control
    join episodes episode
      on episode.tenant_id = control.tenant_id
     and episode.space_id = control.space_id
     and episode.id = control.episode_id
    join participants participant
      on participant.tenant_id = control.tenant_id
     and participant.space_id = control.space_id
     and participant.episode_id = control.episode_id
     and participant.id = $4
     and participant.generation = $5
    where control.tenant_id = $1 and control.space_id = $2 and control.episode_id = $3
    for update of control
    """
  end

  def upsert do
    """
    insert into sync_media_pauses (
      tenant_id, space_id, episode_id, participant_id, participant_generation,
      source, publication_id
    ) values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (tenant_id, episode_id, participant_id, source)
    do update set participant_generation = excluded.participant_generation,
                  publication_id = excluded.publication_id,
                  created_at = now()
    """
  end

  def clear do
    """
    delete from sync_media_pauses
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and participant_id = $4 and source = $5
    """
  end
end
