defmodule ChalkSync.Chat do
  @moduledoc "Durable Space chat commands and collaboration_v1 negotiation."

  alias ChalkSync.Chat.Repository.Message
  alias ChalkSync.Chat.Repository.Postgres, as: PostgresRepository
  alias ChalkSync.Fanout.Collaboration
  alias ChalkSync.Fanout.Collaboration.PostgresNotifications
  alias ChalkSync.Stateholder.Identity

  @extension "collaboration_v1"

  @type options :: [repository: module(), fanout: GenServer.server()]

  @spec negotiate(Identity.t(), map(), pid()) :: {:ok, map()} | {:error, atom()}
  def negotiate(%Identity{} = identity, chat_cursor, socket) when is_pid(socket),
    do: negotiate(identity, chat_cursor, socket, [])

  @spec negotiate(Identity.t(), map(), pid(), options()) :: {:ok, map()} | {:error, atom()}
  def negotiate(%Identity{} = identity, negotiation, socket, options)
      when is_pid(socket) and is_list(options) do
    repository = repository(options)
    fanout = fanout(options)
    {extension, chat_cursor} = negotiation(negotiation)

    with :ok <- valid_chat_cursor(chat_cursor),
         {:ok, capability_state} <- repository.participant_capabilities(identity),
         :ok <- Collaboration.subscribe(fanout, identity.episode, socket),
         {:ok, head} <- repository.head(identity.episode),
         {:ok, receipts} <- negotiated_receipts(repository, identity, extension) do
      {:ok,
       maybe_put_receipts(
         %{
           "name" => extension,
           "capabilities" => capability_state.capabilities,
           "participant_capabilities" => capability_state.participant_capabilities,
           "chat_head_sequence" => head.head_sequence,
           "retained_floor_sequence" => head.retained_floor_sequence
         },
         extension,
         receipts
       )}
    else
      {:error, reason} ->
        Collaboration.unsubscribe(fanout, identity.episode, socket)
        {:error, reason}
    end
  end

  @spec send_chat(Identity.t(), map()) :: {:ok, map()}
  def send_chat(%Identity{} = identity, input), do: send_chat(identity, input, [])

  @spec send_chat(Identity.t(), map(), options()) :: {:ok, map()}
  def send_chat(
        %Identity{} = identity,
        %{client_message_id: client_message_id, text: text} = input,
        options
      )
      when is_binary(client_message_id) and is_binary(text) and is_list(options) do
    repository = repository(options)
    attachment_ids = Map.get(input, :attachment_ids, [])

    case repository.append(identity, %{
           client_message_id: client_message_id,
           text: text,
           attachment_ids: attachment_ids
         }) do
      {:ok, %{outcome: outcome, message: message}} ->
        if outcome == :committed do
          Collaboration.publish_chat_head(fanout(options), identity.episode, %{
            head_sequence: message.sequence,
            retained_floor_sequence: retained_floor(repository, identity)
          })
        end

        {:ok,
         %{
           "type" => "chat_send_result",
           "client_message_id" => client_message_id,
           "outcome" => "accepted",
           "message" => Message.wire(message)
         }}

      {:error, reason} ->
        {:ok, rejected_chat(client_message_id, reason)}
    end
  end

  def send_chat(%Identity{}, input, _options) do
    client_message_id = if is_map(input), do: Map.get(input, :client_message_id, ""), else: ""
    {:ok, rejected_chat(client_message_id, :invalid_payload)}
  end

  @spec read_chat_page(Identity.t(), map()) :: {:ok, map()} | {:error, atom()}
  def read_chat_page(%Identity{} = identity, input),
    do: read_chat_page(identity, input, [])

  @spec read_chat_page(Identity.t(), map(), options()) :: {:ok, map()} | {:error, atom()}
  def read_chat_page(
        %Identity{} = identity,
        %{request_id: request_id, direction: direction, cursor_sequence: cursor, limit: limit},
        options
      )
      when is_binary(request_id) and is_integer(limit) and is_list(options) do
    repository = repository(options)

    with :ok <- validate_operation_id(request_id),
         {:ok, _profile} <- repository.authorize(identity, nil) do
      request = %{
        direction: normalize_direction(direction),
        cursor_sequence: cursor,
        limit: limit
      }

      case repository.read_page(identity.episode, request) do
        {:ok, page} -> {:ok, loaded_page(request_id, page)}
        {:cursor_reset, floor} -> {:ok, cursor_reset_page(request_id, floor)}
        {:error, reason} -> {:error, reason}
      end
    else
      {:error, reason} -> {:error, reason}
    end
  end

  def read_chat_page(%Identity{}, _input, _options), do: {:error, :invalid_payload}

  @spec mark_chat_read(Identity.t(), map(), options()) :: {:ok, map()}
  def mark_chat_read(identity, input, options \\ [])

  def mark_chat_read(
        %Identity{} = identity,
        %{request_id: request_id, sequence: sequence},
        options
      )
      when is_binary(request_id) and is_binary(sequence) and is_list(options) do
    repository = repository(options)

    with :ok <- validate_operation_id(request_id),
         {:ok, result} <- repository.mark_read(identity, sequence) do
      receipt = receipt_frame(result.receipt)

      if result.outcome == :advanced,
        do: Collaboration.publish_chat_read_receipt(fanout(options), identity.episode, receipt)

      {:ok,
       receipt
       |> Map.put("type", "chat_read_result")
       |> Map.put("request_id", request_id)
       |> Map.put("outcome", "accepted")}
    else
      {:error, reason} ->
        {:ok,
         %{
           "type" => "chat_read_result",
           "request_id" => request_id,
           "outcome" => "rejected",
           "error_code" => error_code(reason)
         }}
    end
  end

  def mark_chat_read(%Identity{}, input, _options) do
    request_id = if is_map(input), do: Map.get(input, :request_id, ""), else: ""

    {:ok,
     %{
       "type" => "chat_read_result",
       "request_id" => request_id,
       "outcome" => "rejected",
       "error_code" => "invalid_payload"
     }}
  end

  @spec unsubscribe(Identity.t(), pid()) :: :ok
  def unsubscribe(%Identity{} = identity, socket) when is_pid(socket),
    do: Collaboration.unsubscribe(Collaboration, identity.episode, socket)

  @spec unsubscribe(Identity.t(), pid(), options()) :: :ok
  def unsubscribe(%Identity{} = identity, socket, options)
      when is_pid(socket) and is_list(options),
      do: Collaboration.unsubscribe(fanout(options), identity.episode, socket)

  @spec handle_fanout_notification(String.t(), binary()) :: :ok | {:error, :invalid_payload}
  def handle_fanout_notification(channel, payload) do
    with {:ok, {kind, episode, frame}} <-
           PostgresNotifications.decode_notification(channel, payload) do
      Collaboration.accept_external(Collaboration, kind, episode, frame)
    end
  end

  defp loaded_page(request_id, page) do
    %{
      "type" => "chat_page",
      "request_id" => request_id,
      "outcome" => "loaded",
      "messages" => Enum.map(page.messages, &Message.wire/1),
      "has_more" => page.has_more,
      "head_sequence" => page.head_sequence,
      "retained_floor_sequence" => page.retained_floor_sequence
    }
  end

  defp cursor_reset_page(request_id, floor),
    do: %{
      "type" => "chat_page",
      "request_id" => request_id,
      "outcome" => "cursor_reset",
      "retained_floor_sequence" => floor
    }

  defp rejected_chat(client_message_id, reason),
    do: %{
      "type" => "chat_send_result",
      "client_message_id" => client_message_id,
      "outcome" => "rejected",
      "error_code" => error_code(reason)
    }

  defp error_code(reason)
       when reason in [
              :capability_denied,
              :invalid_payload,
              :rate_limited,
              :overloaded,
              :episode_ended,
              :participant_stale,
              :client_message_id_conflict,
              :attachment_not_found,
              :attachment_not_ready,
              :attachment_already_claimed,
              :attachment_quota_exceeded,
              :dependency_unavailable
            ],
       do: Atom.to_string(reason)

  defp error_code(_reason), do: "dependency_unavailable"

  defp valid_chat_cursor(%{after_sequence: after_sequence, retained_floor_sequence: floor})
       when is_nil(after_sequence) or is_binary(after_sequence),
       do: if(is_nil(floor) or is_binary(floor), do: :ok, else: {:error, :invalid_payload})

  defp valid_chat_cursor(_cursor), do: {:error, :invalid_payload}

  defp validate_operation_id(value),
    do: if(byte_size(value) in 16..64, do: :ok, else: {:error, :invalid_payload})

  defp normalize_direction("older"), do: :older
  defp normalize_direction("newer"), do: :newer
  defp normalize_direction(direction) when direction in [:older, :newer], do: direction
  defp normalize_direction(_direction), do: :invalid

  defp negotiation(%{extension: @extension} = cursor),
    do: {@extension, Map.delete(cursor, :extension)}

  defp negotiation(cursor), do: {@extension, cursor}

  defp negotiated_receipts(repository, identity, @extension),
    do: repository.read_receipts(identity.episode)

  defp maybe_put_receipts(extension, @extension, receipts),
    do: Map.put(extension, "read_receipts", Enum.map(receipts, &receipt_body/1))

  defp receipt_frame(receipt), do: Map.put(receipt_body(receipt), "type", "chat_read_receipt")

  defp receipt_body(receipt),
    do:
      Map.take(receipt, [:participant_id, :participant_generation, :sequence, :read_at])
      |> Map.new(fn {key, value} -> {Atom.to_string(key), value} end)

  defp retained_floor(repository, identity) do
    case repository.head(identity.episode) do
      {:ok, head} -> head.retained_floor_sequence
      {:error, _reason} -> "1"
    end
  end

  defp repository(options),
    do:
      Keyword.get(
        options,
        :repository,
        Application.get_env(:chalk_sync, :chat_repository, PostgresRepository)
      )

  defp fanout(options),
    do:
      Keyword.get(
        options,
        :fanout,
        Application.get_env(:chalk_sync, :collaboration_fanout, Collaboration)
      )
end
