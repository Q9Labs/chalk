defmodule ChalkSync.Stateholder.Postgres.SQL.ParticipantAuthority do
  @moduledoc false

  def participant_authority do
    """
    select
      episode.status,
      participant.generation,
      participant.status,
      participant.role,
      participant.capabilities
    from episodes episode
    left join participants participant
      on participant.tenant_id = episode.tenant_id
     and participant.space_id = episode.space_id
     and participant.episode_id = episode.id
     and participant.id = $4
    where episode.tenant_id = $1 and episode.space_id = $2 and episode.id = $3
    for share of episode
    """
  end
end
