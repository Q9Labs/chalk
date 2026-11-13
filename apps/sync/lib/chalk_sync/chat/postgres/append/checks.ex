defmodule ChalkSync.Chat.Postgres.Append.Checks do
  @moduledoc """
  Pre-insert checks of a chat append: person rate and cap limits and attachment state.
  """

  alias ChalkSync.Chat.Postgres.Store
  alias ChalkSync.Chat.Postgres.Store
  alias ChalkSync.Chat.Repository.SQL
  alias ChalkSync.UUID

  @person_limits %{
    window_messages: 30,
    window_ms: 10_000,
    messages: 10_000,
    bytes: 64 * 1024 * 1024
  }

  defp within_person_rate(connection, identity) do
    limits = person_limits()

    if person_count(connection, identity, SQL.person_recent_messages(), [limits.window_ms]) <
         limits.window_messages,
       do: :ok,
       else: {:error, :rate_limited}
  end

  # The Space stream lock is held here, so two sends from one person, even on two Sync nodes,
  # cannot both pass the window or the caps.
  def within_person_caps(connection, identity, encoded_bytes) do
    limits = person_limits()

    [[count, bytes, recent]] =
      Postgrex.query!(
        connection,
        SQL.person_usage(),
        person_params(identity) ++ [limits.window_ms]
      ).rows

    if recent < limits.window_messages and count < limits.messages and
         bytes + encoded_bytes <= limits.bytes,
       do: :ok,
       else: {:error, :rate_limited}
  end

  defp person_count(connection, identity, sql, params) do
    [[count]] = Postgrex.query!(connection, sql, person_params(identity) ++ params).rows
    count
  end

  defp person_params(identity),
    do: Store.space_params(identity.episode) ++ [Store.uuid(identity.participant_id)]

  defp person_limits,
    do: Map.merge(@person_limits, Application.get_env(:chalk_sync, :chat_person_limits, %{}))

  def attachments(_connection, _identity, [], _query), do: {:ok, []}

  def attachments(connection, identity, attachment_ids, query) do
    dumped_ids = Enum.map(attachment_ids, &Store.uuid/1)

    rows =
      Postgrex.query!(connection, query, Store.episode_params(identity.episode) ++ [dumped_ids]).rows

    cond do
      length(rows) != length(attachment_ids) ->
        {:error, :attachment_not_found}

      Enum.any?(rows, fn [_id, _name, _mime, _bytes, status, owner_id, generation] ->
        status != "ready" or UUID.load!(owner_id) != identity.participant_id or
            generation != identity.participant_generation
      end) ->
        attachment_state_error(rows)

      true ->
        {:ok,
         Enum.map(rows, fn [id, name, mime_type, byte_length, _status, _owner, _generation] ->
           %{
             attachment_id: UUID.load!(id),
             file_name: name,
             mime_type: mime_type,
             byte_length: byte_length
           }
         end)}
    end
  end

  # Cheap checks before the Space stream lock, so a refused flood or a missing file never holds
  # it. A retry whose original committed after the first duplicate lookup can fail them, because
  # the original now fills the window and holds its files, so it goes on to the duplicate lookup
  # under the lock instead.
  def early_checks(connection, identity, input) do
    observe(input, :early_check_observer)

    with :ok <- within_person_rate(connection, identity),
         {:ok, _attachments} <-
           attachments(connection, identity, input.attachment_ids, SQL.read_attachments()) do
      :ok
    else
      {:error, reason} ->
        if Store.select_idempotent(connection, identity, input.client_message_id),
          do: :ok,
          else: {:error, reason}
    end
  end

  def observe(input, key) do
    case Map.get(input, key) do
      observer when is_function(observer, 0) -> observer.()
      _other -> :ok
    end
  end

  defp attachment_state_error(rows) do
    if Enum.any?(rows, fn [_id, _name, _mime, _bytes, status, _owner, _generation] ->
         status == "attached"
       end),
       do: {:error, :attachment_already_claimed},
       else: {:error, :attachment_not_ready}
  end
end
