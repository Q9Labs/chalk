defmodule ChalkSync.Chat.Postgres.Store do
  @moduledoc """
  Shared transaction setup, authority lock, capability check and parameter shaping of the chat repository.
  """

  alias ChalkSync.Chat.Repository.Message
  alias ChalkSync.Chat.Repository.SQL
  alias ChalkSync.Database.TransactionSettings
  alias ChalkSync.Stateholder.Postgres.JoinSeats
  alias ChalkSync.UUID

  @capabilities ["sendReaction", "sendChat"]

  def lock_authority(connection, identity, allow_pending \\ false) do
    params =
      episode_params(identity.episode) ++ [uuid(identity.participant_id)]

    case Postgrex.query!(connection, SQL.lock_authority(), params).rows do
      [["active", generation, status, display_name, _role, capabilities]]
      when generation == identity.participant_generation and is_binary(display_name) ->
        if participant_available?(connection, identity, status, allow_pending) do
          {:ok,
           %{
             display_name: display_name,
             capabilities: ordered_capabilities(capabilities)
           }}
        else
          {:error, :participant_stale}
        end

      [[episode_status, _generation, _participant_status, _display_name, _role, _capabilities]]
      when episode_status != "active" ->
        {:error, :episode_ended}

      [_participant] ->
        {:error, :participant_stale}

      [] ->
        {:error, :participant_stale}
    end
  end

  defp participant_available?(_connection, _identity, "active", _allow_pending), do: true
  defp participant_available?(_connection, _identity, "joining", true), do: true

  defp participant_available?(connection, identity, "leaving", true),
    do: JoinSeats.awaiting_entry?(connection, identity)

  defp participant_available?(_connection, _identity, _status, _allow_pending), do: false

  def require_capability(profile, capability) do
    if capability in profile.capabilities, do: :ok, else: {:error, :capability_denied}
  end

  def transaction_result({:ok, result}), do: {:ok, result}
  def transaction_result({:error, {:error, reason}}), do: {:error, reason}
  def transaction_result({:error, _reason}), do: {:error, :dependency_unavailable}

  def ordered_capabilities(capabilities) do
    Enum.filter(@capabilities, &(&1 in capabilities))
  end

  def configure_transaction(connection) do
    Postgrex.query!(connection, TransactionSettings.sql(:default), [])
  end

  def empty_head, do: %{head_sequence: nil, retained_floor_sequence: nil}

  def receipt([participant_id, generation, sequence, %DateTime{} = read_at]) do
    %{
      participant_id: UUID.load!(participant_id),
      participant_generation: generation,
      sequence: Integer.to_string(sequence),
      read_at: read_at |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    }
  end

  def receipt([participant_id, generation, sequence, %NaiveDateTime{} = read_at]) do
    receipt([
      participant_id,
      generation,
      sequence,
      DateTime.from_naive!(read_at, "Etc/UTC")
    ])
  end

  def episode_params(episode) do
    [uuid(episode.tenant_id), uuid(episode.space_id), uuid(episode.episode_id)]
  end

  def space_params(episode), do: [uuid(episode.tenant_id), uuid(episode.space_id)]

  def uuid(value), do: UUID.dump!(value)

  def select_idempotent(connection, identity, client_message_id) do
    params =
      space_params(identity.episode) ++
        [uuid(identity.participant_id), identity.participant_generation, client_message_id]

    case Postgrex.query!(connection, SQL.select_idempotent_message(), params).rows do
      [] -> nil
      [row] -> {Message.from_row(Enum.take(row, 8)), List.last(row)}
    end
  end
end
