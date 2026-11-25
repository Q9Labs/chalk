defmodule ChalkSync.Stateholder.Postgres.SQL.Authority do
  @moduledoc false

  def lock_control do
    """
    select
      control_revision,
      folded_state,
      state_schema_version,
      state_digest,
      snapshot_bytes
    from sync_episode_control
    where tenant_id = $1 and space_id = $2 and episode_id = $3
    for update
    """
  end

  def lock_episode do
    """
    select status, config_snapshot, deadline_at, deadline_generation, created_at
    from episodes
    where tenant_id = $1 and space_id = $2 and id = $3
    for update
    """
  end

  def lock_participant do
    """
    select
      participants.generation,
      participants.status,
      participants.role,
      participants.capabilities,
      participants.identity_id,
      (case
        when identities.id is not null then identities.kind
        when participants.account_id is not null or participants.role = 'owner' then 'user'
        else 'guest'
      end)::text
    from participants
    left join identities
      on identities.tenant_id = participants.tenant_id
      and identities.id = participants.identity_id
    where participants.tenant_id = $1
      and participants.space_id = $2
      and participants.episode_id = $3
      and participants.id = $4
    for update of participants
    """
  end
end
