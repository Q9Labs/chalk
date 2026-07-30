defmodule ChalkSync.RoomActions do
  @moduledoc """
  Cohesive Sync v3 room-actions domain boundary.

  Public functions return exact generated-contract frame maps. The socket owns
  JSON encoding, logical queue admission, and protocol-phase enforcement.
  """

  alias ChalkSync.RoomActions.Admission
  alias ChalkSync.RoomActions.ChatRepository.Message
  alias ChalkSync.RoomActions.ChatRepository.Postgres, as: PostgresRepository
  alias ChalkSync.RoomActions.Fanout
  alias ChalkSync.RoomActions.Fanout.PostgresNotifications
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID

  @extension_v1 "room_actions_v1"
  @extension_v2 "room_actions_v2"
  @reactions ["👍", "❤️", "😂", "😮", "😢", "🎉"]
  @reaction_ttl_ms 5_000

  @type options :: [
          repository: module(),
          fanout: GenServer.server(),
          admission: GenServer.server(),
          clock: (-> DateTime.t())
        ]

  @spec negotiate(Identity.t(), map(), pid()) :: {:ok, map()} | {:error, atom()}
  def negotiate(%Identity{} = identity, chat_cursor, socket) when is_pid(socket) do
    negotiate(identity, chat_cursor, socket, [])
  end

  @spec negotiate(Identity.t(), map(), pid(), options()) :: {:ok, map()} | {:error, atom()}
  def negotiate(%Identity{} = identity, negotiation, socket, options)
      when is_pid(socket) and is_list(options) do
    repository = repository(options)
    fanout = fanout(options)
    {extension, chat_cursor} = negotiation(negotiation)

    with :ok <- valid_chat_cursor(chat_cursor),
         {:ok, capability_state} <- repository.participant_capabilities(identity),
         :ok <- Fanout.subscribe(fanout, identity.session, socket),
         {:ok, head} <- repository.head(identity.session),
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
        Fanout.unsubscribe(fanout, identity.session, socket)
        {:error, reason}
    end
  end

  @spec send_reaction(Identity.t(), map()) :: {:ok, map()}
  def send_reaction(%Identity{} = identity, input), do: send_reaction(identity, input, [])

  @spec send_reaction(Identity.t(), map(), options()) :: {:ok, map()}
  def send_reaction(
        %Identity{} = identity,
        %{operation_id: operation_id, reaction: reaction},
        options
      )
      when is_binary(operation_id) and is_binary(reaction) and is_list(options) do
    repository = repository(options)

    with :ok <- validate_operation_id(operation_id),
         :ok <- validate_reaction(reaction),
         {:ok, profile} <- repository.authorize(identity, "sendReaction"),
         :ok <- Admission.admit_reaction(admission(options), identity),
         {:ok, event} <- publish_reaction(identity, profile.display_name, reaction, options) do
      {:ok,
       %{
         "type" => "room_reaction_result",
         "operation_id" => operation_id,
         "outcome" => "accepted",
         "reaction" => event
       }}
    else
      {:error, reason} -> {:ok, rejected_reaction(operation_id, reason)}
    end
  end

  def send_reaction(%Identity{}, input, _options) do
    operation_id = if is_map(input), do: Map.get(input, :operation_id, ""), else: ""
    {:ok, rejected_reaction(operation_id, :invalid_payload)}
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
          head = %{
            head_sequence: message.sequence,
            retained_floor_sequence: retained_floor(repository, identity)
          }

          Fanout.publish_chat_head(fanout(options), identity.session, head)
        end

        {:ok,
         %{
           "type" => "chat_send_result",
           "client_message_id" => client_message_id,
           "outcome" => "accepted",
           "message" => Message.wire(message, version(options))
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
        %{
          request_id: request_id,
          direction: direction,
          cursor_sequence: cursor,
          limit: limit
        },
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

      case repository.read_page(identity.session, request) do
        {:ok, page} -> {:ok, loaded_page(request_id, page, version(options))}
        {:cursor_reset, floor} -> {:ok, cursor_reset_page(request_id, floor)}
        {:error, reason} -> {:error, reason}
      end
    else
      {:error, reason} -> {:error, reason}
    end
  end

  def read_chat_page(%Identity{}, input, _options) do
    _request_id = if is_map(input), do: Map.get(input, :request_id, ""), else: ""
    {:error, :invalid_payload}
  end

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
        do: Fanout.publish_chat_read_receipt(fanout(options), identity.session, receipt)

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
  def unsubscribe(%Identity{} = identity, socket) when is_pid(socket) do
    Fanout.unsubscribe(default_fanout(), identity.session, socket)
  end

  @spec unsubscribe(Identity.t(), pid(), options()) :: :ok
  def unsubscribe(%Identity{} = identity, socket, options)
      when is_pid(socket) and is_list(options) do
    Fanout.unsubscribe(fanout(options), identity.session, socket)
  end

  @spec handle_fanout_notification(String.t(), binary()) :: :ok | {:error, :invalid_payload}
  def handle_fanout_notification(channel, payload) do
    with {:ok, {kind, session, frame}} <-
           PostgresNotifications.decode_notification(channel, payload) do
      Fanout.accept_external(default_fanout(), kind, session, frame)
    end
  end

  defp publish_reaction(identity, display_name, reaction, options) do
    occurred_at = clock(options).()
    expires_at = DateTime.add(occurred_at, @reaction_ttl_ms, :millisecond)

    event = %{
      "type" => "room_reaction",
      "event_id" => UUID.generate(),
      "participant_session_id" => identity.participant_session_id,
      "display_name" => display_name,
      "reaction" => reaction,
      "occurred_at" => DateTime.to_iso8601(occurred_at),
      "expires_at" => DateTime.to_iso8601(expires_at)
    }

    case Fanout.publish_reaction(fanout(options), identity.session, event) do
      :ok -> {:ok, event}
      {:error, _reason} -> {:error, :dependency_unavailable}
    end
  end

  defp retained_floor(repository, identity) do
    case repository.head(identity.session) do
      {:ok, head} -> head.retained_floor_sequence
      {:error, _reason} -> "1"
    end
  end

  defp loaded_page(request_id, page, version) do
    %{
      "type" => "chat_page",
      "request_id" => request_id,
      "outcome" => "loaded",
      "messages" => Enum.map(page.messages, &Message.wire(&1, version)),
      "has_more" => page.has_more,
      "head_sequence" => page.head_sequence,
      "retained_floor_sequence" => page.retained_floor_sequence
    }
  end

  defp cursor_reset_page(request_id, floor) do
    %{
      "type" => "chat_page",
      "request_id" => request_id,
      "outcome" => "cursor_reset",
      "retained_floor_sequence" => floor
    }
  end

  defp rejected_reaction(operation_id, reason) do
    %{
      "type" => "room_reaction_result",
      "operation_id" => operation_id,
      "outcome" => "rejected",
      "error_code" => error_code(reason)
    }
  end

  defp rejected_chat(client_message_id, reason) do
    %{
      "type" => "chat_send_result",
      "client_message_id" => client_message_id,
      "outcome" => "rejected",
      "error_code" => error_code(reason)
    }
  end

  defp error_code(reason)
       when reason in [
              :capability_denied,
              :invalid_payload,
              :rate_limited,
              :overloaded,
              :session_ended,
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

  defp valid_chat_cursor(%{
         after_sequence: after_sequence,
         retained_floor_sequence: retained_floor_sequence
       })
       when is_nil(after_sequence) or is_binary(after_sequence) do
    if is_nil(retained_floor_sequence) or is_binary(retained_floor_sequence),
      do: :ok,
      else: {:error, :invalid_payload}
  end

  defp valid_chat_cursor(_cursor), do: {:error, :invalid_payload}

  defp validate_reaction(reaction) do
    if reaction in @reactions, do: :ok, else: {:error, :invalid_payload}
  end

  defp validate_operation_id(value) do
    if byte_size(value) in 16..64, do: :ok, else: {:error, :invalid_payload}
  end

  defp normalize_direction("older"), do: :older
  defp normalize_direction("newer"), do: :newer
  defp normalize_direction(direction) when direction in [:older, :newer], do: direction
  defp normalize_direction(_direction), do: :invalid

  defp negotiation(%{extension: extension} = cursor)
       when extension in [@extension_v1, @extension_v2],
       do: {extension, Map.delete(cursor, :extension)}

  defp negotiation(cursor), do: {@extension_v1, cursor}

  defp negotiated_receipts(_repository, _identity, @extension_v1), do: {:ok, []}

  defp negotiated_receipts(repository, identity, @extension_v2),
    do: repository.read_receipts(identity.session)

  defp maybe_put_receipts(extension, @extension_v1, _receipts), do: extension

  defp maybe_put_receipts(extension, @extension_v2, receipts) do
    Map.put(extension, "read_receipts", Enum.map(receipts, &receipt_body/1))
  end

  defp receipt_frame(receipt), do: Map.put(receipt_body(receipt), "type", "chat_read_receipt")

  defp receipt_body(receipt) do
    %{
      "participant_session_id" => receipt.participant_session_id,
      "participant_session_generation" => receipt.participant_session_generation,
      "sequence" => receipt.sequence,
      "read_at" => receipt.read_at
    }
  end

  defp version(options), do: Keyword.get(options, :version, 1)

  defp repository(options) do
    Keyword.get(
      options,
      :repository,
      Application.get_env(
        :chalk_sync,
        :room_actions_chat_repository,
        PostgresRepository
      )
    )
  end

  defp admission(options) do
    Keyword.get(
      options,
      :admission,
      Application.get_env(:chalk_sync, :room_actions_admission, Admission)
    )
  end

  defp fanout(options) do
    Keyword.get(options, :fanout, default_fanout())
  end

  defp default_fanout do
    Application.get_env(:chalk_sync, :room_actions_fanout, Fanout)
  end

  defp clock(options), do: Keyword.get(options, :clock, &DateTime.utc_now/0)
end
