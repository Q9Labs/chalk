defmodule ChalkSync.ProtocolV3 do
  @moduledoc "Strict protocol-v3 framing at the WebSocket boundary."

  alias ChalkSync.Contract.GeneratedV3
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.UUID

  @limits GeneratedV3.limits()
  @inbound_frame_bytes @limits["decodedInboundFrameBytes"]
  @replay_page_events @limits["replayPageMaxEvents"]
  @replay_page_bytes @limits["replayPageEncodedBytes"]
  @error_detail_bytes @limits["protocolErrorDetailBytes"]

  def decode(text)
      when is_binary(text) and byte_size(text) <= @inbound_frame_bytes do
    with {:ok, %{} = frame} <- JSON.decode(text),
         {:ok, decoded} <- GeneratedV3.decode_client_frame(frame),
         {:ok, normalized} <- normalize(decoded) do
      {:ok, normalized}
    else
      {:ok, _other} -> {:error, :invalid_frame}
      {:error, %JSON.DecodeError{}} -> {:error, :invalid_json}
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :invalid_frame}
    end
  end

  def decode(text) when is_binary(text), do: {:error, :frame_too_large}
  def decode(_frame), do: {:error, :invalid_frame}

  def recovery_id, do: UUID.generate()

  def recovery_welcome(%Identity{} = identity, %Recovery{} = recovery, recovery_id) do
    base = %{
      "type" => "welcome",
      "protocol" => 3,
      "participant_session_id" => identity.participant_session_id,
      "participant_session_generation" => identity.participant_session_generation,
      "recovery_id" => recovery_id,
      "head" => head(recovery.head),
      "mode" => Atom.to_string(recovery.mode)
    }

    frame =
      case recovery.mode do
        :snapshot ->
          Map.put(
            base,
            "snapshot",
            Map.put(recovery.snapshot, "state_digest", digest(recovery.head.digest))
          )

        :terminal ->
          Map.put(base, "reason", Atom.to_string(recovery.terminal_reason || :session_ended))

        mode when mode in [:replay, :up_to_date] ->
          base
      end

    encode!(frame)
  end

  def recovery_page([_ | _] = events, recovery_id) do
    page = Enum.take(events, @replay_page_events)
    frames = Enum.map(page, &event_frame/1)

    frame = %{
      "type" => "replay_page",
      "recovery_id" => recovery_id,
      "first_revision" => hd(frames)["revision"],
      "last_revision" => List.last(frames)["revision"],
      "events" => frames
    }

    if frame |> JSON.encode!() |> byte_size() <= @replay_page_bytes,
      do: {:ok, encode!(frame), List.last(frames)["revision"]},
      else: {:error, :replay_page_too_large}
  end

  def recovery_page([], _recovery_id), do: {:error, :empty_replay_page}

  def recovery_complete(%Recovery{} = recovery, recovery_id),
    do:
      encode!(%{
        "type" => "recovery_complete",
        "recovery_id" => recovery_id,
        "head" => head(recovery.head)
      })

  def event(event), do: event |> event_frame() |> encode!()

  def ack(%Decision{result: :pending, command_id: command_id}),
    do: operation_pending(command_id)

  def ack(%Decision{} = decision) do
    delivery = Atom.to_string(decision.delivery || :original)

    frame =
      case decision.result do
        :committed ->
          %{
            "type" => "ack",
            "command_id" => decision.command_id,
            "delivery" => delivery,
            "outcome" => "committed",
            "event_id" => decision.event_id,
            "revision" => decision.revision,
            "state_digest" => digest(decision.state_digest)
          }

        :satisfied ->
          %{
            "type" => "ack",
            "command_id" => decision.command_id,
            "delivery" => delivery,
            "outcome" => "satisfied",
            "revision" => decision.revision,
            "state_digest" => digest(decision.state_digest)
          }

        result when result in [:rejected, :command_id_conflict] ->
          %{
            "type" => "ack",
            "command_id" => decision.command_id,
            "delivery" => delivery,
            "outcome" => Atom.to_string(result),
            "reason" => Atom.to_string(decision.reason)
          }
      end

    encode!(frame)
  end

  def operation_pending(command_id), do: retryable(command_id, :external_operation_pending)

  def operation_decision(%OperationDecision{result: :pending, request_key: command_id}),
    do: operation_pending(command_id)

  def operation_decision(%OperationDecision{result: :applied} = decision) do
    encode!(%{
      "type" => "ack",
      "command_id" => decision.request_key,
      "delivery" => operation_delivery(decision),
      "outcome" => "committed",
      "event_id" => decision.event_id,
      "revision" => decision.revision,
      "state_digest" => digest(decision.state_digest)
    })
  end

  def operation_decision(%OperationDecision{result: :failed} = decision),
    do: rejected_operation(decision, :external_operation_failed)

  def operation_decision(%OperationDecision{result: :rejected} = decision),
    do: rejected_operation(decision, decision.reason)

  def operation_decision(%OperationDecision{result: :command_id_conflict} = decision) do
    encode!(%{
      "type" => "ack",
      "command_id" => decision.request_key,
      "delivery" => operation_delivery(decision),
      "outcome" => "command_id_conflict",
      "reason" => "command_id_conflict"
    })
  end

  def retryable(command_id, code),
    do:
      encode!(%{
        "type" => "retryable_error",
        "command_id" => command_id,
        "code" => Atom.to_string(code)
      })

  def error(code, detail),
    do:
      encode!(%{
        "type" => "error",
        "code" => Atom.to_string(code),
        "detail" => binary_part(detail, 0, min(byte_size(detail), @error_detail_bytes))
      })

  def pong, do: encode!(%{"type" => "pong"})

  def encode!(frame) do
    if GeneratedV3.valid_server_frame?(frame),
      do: JSON.encode!(frame),
      else: raise(ArgumentError, "invalid protocol-v3 server frame")
  end

  defp normalize({:hello, %{token: token, streams: streams}}) do
    cursor = streams["control"]["cursor"]

    case cursor do
      nil ->
        {:ok, {:hello, %{token: token, cursor: nil}}}

      cursor ->
        with {:ok, decoded} <- Base.decode16(cursor["state_digest"], case: :lower) do
          {:ok,
           {:hello,
            %{
              token: token,
              cursor: %{
                revision: cursor["revision"],
                state_schema_version: cursor["state_schema_version"],
                digest: decoded
              }
            }}}
        end
    end
  end

  defp normalize({:operation, operation}) do
    {:ok,
     {:operation,
      %{operation | payload: normalize_operation_payload(operation.name, operation.payload)}}}
  end

  defp normalize({:command, command}) do
    {:ok,
     {:command, %{command | payload: normalize_command_payload(command.name, command.payload)}}}
  end

  defp normalize(frame), do: {:ok, frame}

  defp normalize_operation_payload(name, %{"participant_session_id" => id})
       when name in [
              :mute_participant,
              :stop_participant_camera,
              :stop_participant_screen_share,
              :remove_participant
            ],
       do: %{"participantSessionId" => id}

  defp normalize_operation_payload(name, %{"admission_request_id" => id})
       when name in [:admit_participant, :deny_admission],
       do: %{"admissionRequestId" => id}

  defp normalize_operation_payload(name, %{"recording_id" => id})
       when name in [:start_recording, :stop_recording],
       do: %{"recordingId" => id}

  defp normalize_operation_payload(_name, payload), do: payload

  defp normalize_command_payload(:set_display_name, %{"display_name" => display_name}),
    do: %{"displayName" => display_name}

  defp normalize_command_payload(:set_participant_role, payload) do
    %{
      "participantSessionId" => payload["participant_session_id"],
      "role" => payload["role"]
    }
  end

  defp normalize_command_payload(:transfer_host, %{"participant_session_id" => participant_id}),
    do: %{"participantSessionId" => participant_id}

  defp normalize_command_payload(_name, payload), do: payload

  defp event_frame(event) do
    base = %{
      "type" => "event",
      "stream" => "control",
      "name" => field(event, :name),
      "event_id" => field(event, :event_id),
      "base_revision" => field(event, :base_revision),
      "revision" => field(event, :revision),
      "schema_version" => field(event, :schema_version),
      "resulting_state_digest" => event |> field(:resulting_state_digest) |> digest(),
      "payload" => field(event, :payload)
    }

    origins = [
      {"command_id", field(event, :command_id)},
      {"lifecycle_intent_id", field(event, :lifecycle_intent_id)},
      {"external_operation_id", field(event, :external_operation_id)}
    ]

    case Enum.filter(origins, fn {_key, value} -> is_binary(value) end) do
      [{key, value}] -> Map.put(base, key, value)
      _ -> raise ArgumentError, "protocol-v3 event must have exactly one durable origin"
    end
  end

  defp head(head),
    do: %{
      "revision" => head.revision,
      "state_schema_version" => head.state_schema_version,
      "state_digest" => digest(head.digest)
    }

  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp digest(value), do: Base.encode16(value, case: :lower)

  defp rejected_operation(decision, reason) do
    encode!(%{
      "type" => "ack",
      "command_id" => decision.request_key,
      "delivery" => operation_delivery(decision),
      "outcome" => "rejected",
      "reason" => Atom.to_string(reason)
    })
  end

  defp operation_delivery(%{delivery: delivery}) when delivery in [:original, :duplicate],
    do: Atom.to_string(delivery)

  defp operation_delivery(_decision), do: "original"
end
