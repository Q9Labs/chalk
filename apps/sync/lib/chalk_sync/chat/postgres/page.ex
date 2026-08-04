defmodule ChalkSync.Chat.Repository.Postgres.Page do
  @moduledoc false

  alias ChalkSync.Chat.Repository.Message
  alias ChalkSync.Chat.Repository.SQL
  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID

  @transaction_timeout_ms 3_000
  @limits GeneratedV1.limits()
  @page_encoded_bytes @limits["chatPageEncodedBytes"]
  @correlation_reserved_bytes @limits["correlationReservedBytes"]
  @page_producer_encoded_bytes @page_encoded_bytes - @correlation_reserved_bytes
  @page_max_messages @limits["chatPageMaxMessages"]
  @max_signed_bigint 9_223_372_036_854_775_807

  def read(
        %EpisodeKey{} = episode,
        %{direction: direction, cursor_sequence: cursor, limit: limit}
      )
      when direction in [:older, :newer] and is_integer(limit) and limit > 0 and
             limit <= @page_max_messages do
    with {:ok, parsed_cursor} <- parse_cursor(cursor) do
      read_transaction(episode, direction, parsed_cursor, limit)
    end
  end

  def read(%EpisodeKey{}, _request), do: {:error, :invalid_payload}

  defp read_transaction(episode, direction, cursor, limit) do
    case Postgrex.transaction(
           Database.connection(episode),
           fn connection ->
             configure_transaction(connection)
             read_in_transaction(connection, episode, direction, cursor, limit)
           end,
           timeout: @transaction_timeout_ms,
           commit_comment: "chalk sync chat page"
         ) do
      {:ok, result} -> result
      {:error, {:error, reason}} -> {:error, reason}
      {:error, _reason} -> {:error, :dependency_unavailable}
    end
  rescue
    _exception -> {:error, :dependency_unavailable}
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  defp read_in_transaction(connection, episode, direction, cursor, limit) do
    stream_params = space_params(episode)
    params = space_params(episode)

    case Postgrex.query!(connection, SQL.lock_stream_for_read(), stream_params).rows do
      [] ->
        {:ok, empty_page()}

      [[head_sequence, retained_floor]] ->
        read_retained(
          connection,
          params,
          direction,
          cursor,
          limit,
          head_sequence,
          retained_floor
        )
    end
  end

  defp read_retained(
         connection,
         params,
         direction,
         cursor,
         limit,
         head_sequence,
         retained_floor
       ) do
    if cursor_reset?(direction, cursor, retained_floor) do
      {:cursor_reset, Integer.to_string(retained_floor)}
    else
      messages =
        connection
        |> query(params, direction, cursor, limit, head_sequence, retained_floor)
        |> Enum.map(&Message.from_row/1)

      page_if_contiguous(messages, direction, limit, head_sequence, retained_floor)
    end
  end

  defp page_if_contiguous(messages, direction, limit, head_sequence, retained_floor) do
    if contiguous?(messages, direction),
      do: build(messages, direction, limit, head_sequence, retained_floor),
      else: {:error, :dependency_unavailable}
  end

  defp query(connection, params, :newer, cursor, limit, head_sequence, retained_floor) do
    start_sequence = cursor || retained_floor - 1

    Postgrex.query!(
      connection,
      SQL.read_newer_page(),
      params ++ [start_sequence, head_sequence, limit + 1]
    ).rows
  end

  defp query(connection, params, :older, cursor, limit, head_sequence, retained_floor) do
    start_sequence = cursor || head_sequence + 1

    Postgrex.query!(
      connection,
      SQL.read_older_page(),
      params ++ [start_sequence, retained_floor, limit + 1]
    ).rows
  end

  defp build(messages, direction, limit, head_sequence, retained_floor) do
    selected =
      messages
      |> Enum.take(limit)
      |> fit_encoded(head_sequence, retained_floor)

    ordered = if direction == :older, do: Enum.reverse(selected), else: selected

    {:ok,
     %{
       messages: ordered,
       has_more: length(selected) < length(messages),
       head_sequence: Integer.to_string(head_sequence),
       retained_floor_sequence: Integer.to_string(retained_floor)
     }}
  end

  defp fit_encoded(messages, head_sequence, retained_floor) do
    Enum.reduce_while(messages, [], fn message, selected ->
      candidate = selected ++ [message]

      bytes =
        candidate
        |> page_frame(head_sequence, retained_floor)
        |> JSON.encode!()
        |> byte_size()

      if bytes <= @page_producer_encoded_bytes,
        do: {:cont, candidate},
        else: {:halt, selected}
    end)
  end

  defp page_frame(messages, head_sequence, retained_floor) do
    %{
      "type" => "chat_page",
      "request_id" => String.duplicate("0", 64),
      "outcome" => "loaded",
      "messages" => Enum.map(messages, &Message.wire/1),
      "has_more" => false,
      "head_sequence" => Integer.to_string(head_sequence),
      "retained_floor_sequence" => Integer.to_string(retained_floor)
    }
  end

  defp cursor_reset?(_direction, nil, _retained_floor), do: false
  defp cursor_reset?(:newer, cursor, retained_floor), do: cursor < retained_floor - 1
  defp cursor_reset?(:older, cursor, retained_floor), do: cursor < retained_floor

  defp contiguous?([], _direction), do: true

  defp contiguous?(messages, direction) do
    expected_step = if direction == :older, do: -1, else: 1

    messages
    |> Enum.map(&String.to_integer(&1.sequence))
    |> Enum.chunk_every(2, 1, :discard)
    |> Enum.all?(fn [left, right] -> right - left == expected_step end)
  end

  defp parse_cursor(nil), do: {:ok, nil}

  defp parse_cursor(cursor) when is_binary(cursor) do
    case Integer.parse(cursor) do
      {value, ""} when value >= 0 and value <= @max_signed_bigint -> {:ok, value}
      _ -> {:error, :invalid_payload}
    end
  end

  defp parse_cursor(_cursor), do: {:error, :invalid_payload}

  defp empty_page do
    %{
      messages: [],
      has_more: false,
      head_sequence: nil,
      retained_floor_sequence: nil
    }
  end

  defp configure_transaction(connection) do
    Postgrex.query!(connection, SQL.transaction_settings(), [])
  end

  defp space_params(episode) do
    [
      UUID.dump!(episode.tenant_id),
      UUID.dump!(episode.space_id)
    ]
  end
end
