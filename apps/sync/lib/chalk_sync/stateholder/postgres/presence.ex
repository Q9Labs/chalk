defmodule ChalkSync.Stateholder.Postgres.Presence do
  @moduledoc false

  alias ChalkSync.Obs
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.Transaction

  # Room liveness and participant attendance have separate clocks. Renewal is
  # serialized with removal by the Episode authority lock, across Sync nodes.
  def renew(connection, identity) do
    %{rows: [[renewed?, lapsed?]]} =
      Postgrex.query!(
        connection,
        """
        with previous_lease as (
          select expires_at <= statement_timestamp() as lapsed
          from participant_presence_leases
          where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
        ), participant_lease as (
          insert into participant_presence_leases
            (tenant_id, space_id, episode_id, participant_id, generation, expires_at)
          select $1, $2, $3, $4, $5, clock_timestamp() + interval '120 seconds'
          from participants
          where tenant_id=$1 and space_id=$2 and episode_id=$3 and id=$4
            and generation=$5 and status in ('joining', 'active')
          on conflict (tenant_id, space_id, episode_id, participant_id) do update
            set generation=excluded.generation, expires_at=excluded.expires_at
          returning 1
        ), episode_lease as (
          insert into episode_presence_leases (tenant_id, space_id, episode_id, expires_at)
          select $1, $2, $3, clock_timestamp() + interval '120 seconds'
          from participants
          where tenant_id=$1 and space_id=$2 and episode_id=$3 and id=$4
            and generation=$5 and status in ('joining', 'active', 'leaving')
          on conflict (tenant_id, space_id, episode_id) do update
            set expires_at=excluded.expires_at
        )
        select exists(select 1 from participant_lease), coalesce((select lapsed from previous_lease), false)
        """,
        Scope.participant(identity) ++ [identity.participant_generation]
      )

    case {renewed?, lapsed?} do
      {true, true} -> "renewed_after_expiry"
      {true, false} -> "renewed"
      {false, _} -> "not_renewed"
    end
  end

  def transaction(connection, identity) do
    Transaction.configure(connection)
    Authority.lock_control(connection, identity.episode)
    policy = Authority.lock_episode(connection, identity.episode)

    if policy.status == "active", do: renew(connection, identity), else: "not_renewed"
  end

  def observe(identity, result) do
    Obs.fact("sync.presence_renewal", %{
      tenant_id: identity.episode.tenant_id,
      space_id: identity.episode.space_id,
      episode_id: identity.episode.episode_id,
      participant_id: identity.participant_id,
      generation: identity.participant_generation,
      presence_renewal: result
    })
  end
end
