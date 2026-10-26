defmodule ChalkSync.Stateholder.Postgres.Presence do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.Transaction

  # Room liveness and participant attendance have separate clocks. Renewal is
  # serialized with removal by the Episode authority lock, across Sync nodes.
  def renew(connection, identity) do
    Postgrex.query!(
      connection,
      """
      insert into participant_presence_leases
        (tenant_id, space_id, episode_id, participant_id, generation, expires_at)
      select $1, $2, $3, $4, $5, clock_timestamp() + interval '120 seconds'
      from participants
      where tenant_id=$1 and space_id=$2 and episode_id=$3 and id=$4
        and generation=$5 and status in ('joining', 'active')
      on conflict (tenant_id, space_id, episode_id, participant_id) do update
        set generation=excluded.generation, expires_at=excluded.expires_at
      """,
      Scope.participant(identity) ++ [identity.participant_generation]
    )

    Postgrex.query!(
      connection,
      """
      insert into episode_presence_leases (tenant_id, space_id, episode_id, expires_at)
      select $1, $2, $3, clock_timestamp() + interval '120 seconds'
      from participants
      where tenant_id=$1 and space_id=$2 and episode_id=$3 and id=$4
        and generation=$5 and status in ('joining', 'active', 'leaving')
      on conflict (tenant_id, space_id, episode_id) do update
        set expires_at=excluded.expires_at
      """,
      Scope.participant(identity) ++ [identity.participant_generation]
    )

    :ok
  end

  def transaction(connection, identity) do
    Transaction.configure(connection)
    Authority.lock_control(connection, identity.episode)
    policy = Authority.lock_episode(connection, identity.episode)

    if policy.status == "active", do: renew(connection, identity), else: :ok
  end
end
