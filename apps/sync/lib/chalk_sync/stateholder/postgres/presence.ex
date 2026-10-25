defmodule ChalkSync.Stateholder.Postgres.Presence do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.Transaction

  # Match the entry window: several 20-second heartbeats, with room for a
  # mobile network switch. No node-local disconnect timer owns durable leave.
  def renew(connection, identity) do
    Postgrex.query!(
      connection,
      """
      insert into participant_presence_leases
        (tenant_id, space_id, episode_id, participant_id, participant_generation, expires_at)
      values ($1, $2, $3, $4, $5, clock_timestamp() + interval '120 seconds')
      on conflict (participant_id) do update
        set participant_generation=excluded.participant_generation, expires_at=excluded.expires_at
      """,
      Scope.participant(identity) ++ [identity.participant_generation]
    )

    :ok
  end

  def transaction(connection, identity) do
    Transaction.configure(connection)
    Authority.lock_control(connection, identity.episode)
    policy = Authority.lock_episode(connection, identity.episode)

    participant =
      Authority.lock_participant(connection, identity.episode, identity.participant_id)

    if policy.status == "active" && participant &&
         participant.generation == identity.participant_generation &&
         participant.status in ["joining", "active"] do
      renew(connection, identity)
    else
      Postgrex.rollback(connection, {:error, :participant_inactive})
    end
  end
end
