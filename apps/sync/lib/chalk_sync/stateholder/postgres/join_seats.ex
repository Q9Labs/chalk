defmodule ChalkSync.Stateholder.Postgres.JoinSeats do
  @moduledoc """
  Pending -> joined on an authenticated hello, or cancelled/expired before hello.
  The Episode authority lock serializes each transition with lifecycle events.
  Absence of a seat row retains the previous admission protocol during rollout.
  """

  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.UUID

  def prepare(connection, episode, intent, identity) do
    if identity &&
         (intent.participant_id != identity.participant_id ||
            intent.participant_generation != identity.participant_generation) do
      Postgrex.rollback(connection, {:error, :stale_participant_generation})
    end

    if intent.name == "participant_joined" and intent.status == "pending" do
      prepare_pending(connection, episode, intent, identity)
    else
      :ok
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
      [[state]] when state in ["cancelled", "expired", "left"] -> :expired
      [["pending"]] -> Postgrex.rollback(connection, {:retryable, :admission_pending})
      _ -> Postgrex.rollback(connection, {:error, :invalid_admission_intent})
    end
  end
end
