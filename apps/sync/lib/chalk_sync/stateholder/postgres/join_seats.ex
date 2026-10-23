defmodule ChalkSync.Stateholder.Postgres.JoinSeats do
  @moduledoc """
  Pending -> joined only on explicit entry after Sync and SFU startup.
  Failed startup remains cancellable until then.
  The Episode authority lock serializes each transition with lifecycle events.
  Absence of a seat row retains the previous admission protocol during rollout.
  """

  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.UUID

  def claim_entry(_connection, nil), do: :ok
  def claim_entry(_connection, %{entry_token_id: nil}), do: :ok

  def claim_entry(connection, identity) do
    Postgrex.query!(
      connection,
      """
      update participant_join_seats set entry_token_id=$6
      where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4
        and generation=$5 and state='joined'
      """,
      Scope.participant(identity) ++ [identity.participant_generation, identity.entry_token_id]
    )

    :ok
  end

  def validate_leave(connection, %{entry_token_id: token} = identity, %{name: :participant_leave})
      when is_binary(token) do
    case Postgrex.query!(
           connection,
           """
           select entry_token_id from participant_join_seats
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4
             and generation=$5
           """,
           Scope.participant(identity) ++ [identity.participant_generation]
         ).rows do
      [[owner]] when not is_nil(owner) and owner != token -> {:error, :participant_inactive}
      _ -> :ok
    end
  end

  def validate_leave(_connection, _identity, _operation), do: :ok

  def prepare(connection, episode, intent, identity) do
    if identity &&
         (intent.participant_id != identity.participant_id ||
            intent.participant_generation != identity.participant_generation) do
      Postgrex.rollback(connection, {:error, :stale_participant_generation})
    end

    cond do
      intent.name != "participant_joined" -> :ok
      intent.status == "pending" -> prepare_pending(connection, episode, intent, identity)
      identity && intent.status == "superseded" -> reaped_seat(connection, episode, intent)
      true -> :ok
    end
  end

  # The lifecycle consumer may already have expired this generation's lease.
  defp reaped_seat(connection, episode, intent) do
    case Postgrex.query!(
           connection,
           """
           select state from participant_join_seats
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
           """,
           Scope.episode(episode) ++
             [UUID.dump!(intent.participant_id), intent.participant_generation]
         ).rows do
      [["expired"]] -> :entry_expired
      _ -> :ok
    end
  end

  defp prepare_pending(connection, episode, intent, identity) do
    action = if is_nil(identity), do: "expire", else: "confirm"

    params =
      Scope.episode(episode) ++
        [UUID.dump!(intent.participant_id), intent.participant_generation, action]

    case Postgrex.query!(
           connection,
           "select transition_participant_join_seat($1,$2,$3,$4,$5,$6)",
           params
         ).rows do
      [[state]] when state in ["legacy", "joined"] -> :ok
      [["expired"]] when not is_nil(identity) -> :entry_expired
      [[state]] when state in ["cancelled", "expired", "left"] -> :expired
      [["pending"]] -> Postgrex.rollback(connection, {:retryable, :admission_pending})
      _ -> Postgrex.rollback(connection, {:error, :invalid_admission_intent})
    end
  end
end
