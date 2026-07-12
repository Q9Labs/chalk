defmodule ChalkSync.ProtocolV2 do
  @moduledoc """
  Strict protocol-v2 framing at the WebSocket boundary.

  The generated contract validates wire shapes. This module performs the
  semantic conversions between wire cursors, durable state, events, and
  command decisions without allowing frame fields to supply identity.
  """

  alias ChalkSync.Contract.GeneratedV2
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.UUID

  @limits GeneratedV2.limits()
  @inbound_frame_bytes @limits["decodedInboundFrameBytes"]
  @replay_page_events @limits["replayPageMaxEvents"]
  @replay_page_bytes @limits["replayPageEncodedBytes"]

  @type decoded_frame ::
          {:hello, %{token: String.t(), cursor: map() | nil}}
          | {:command, %{command_id: String.t(), name: atom(), payload: map()}}
          | {:delivery_ack,
             %{stream: :control, revision: pos_integer(), state_digest: String.t()}}
          | {:recovery_ack,
             %{
               recovery_id: String.t(),
               revision: non_neg_integer(),
               state_digest: String.t()
             }}
          | :ping

  @spec decode(binary()) :: {:ok, decoded_frame()} | {:error, atom()}
  def decode(text) when is_binary(text) and byte_size(text) <= @inbound_frame_bytes do
    with {:ok, %{} = frame} <- JSON.decode(text),
         {:ok, decoded} <- GeneratedV2.decode_client_frame(frame),
         {:ok, normalized} <- normalize_client_frame(decoded) do
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

  @spec recovery_id() :: String.t()
  def recovery_id, do: UUID.generate()

  @spec recovery_welcome(Identity.t(), Recovery.t(), String.t()) :: binary()
  def recovery_welcome(%Identity{} = identity, %Recovery{} = recovery, recovery_id),
    do: identity |> welcome_frame(recovery, recovery_id) |> encode!()

  @spec recovery_page([map()], String.t()) :: {:ok, binary(), pos_integer()} | {:error, atom()}
  def recovery_page([_ | _] = events, recovery_id) when is_binary(recovery_id) do
    page_events =
      Enum.reduce_while(events, [], fn event, accepted ->
        candidate = accepted ++ [event_frame(event)]

        if replay_page_fits?(candidate, recovery_id),
          do: {:cont, candidate},
          else: {:halt, accepted}
      end)

    case page_events do
      [] ->
        {:error, :replay_page_too_large}

      events ->
        frame = replay_page_frame(events, recovery_id)
        {:ok, encode!(frame), List.last(events)["revision"]}
    end
  end

  def recovery_page([], _recovery_id), do: {:error, :empty_replay_page}

  @spec recovery_complete(Recovery.t(), String.t()) :: binary()
  def recovery_complete(%Recovery{} = recovery, recovery_id),
    do: recovery |> recovery_complete_frame(recovery_id) |> encode!()

  @spec event(map()) :: binary()
  def event(event), do: event |> event_frame() |> encode!()

  @spec ack(Decision.t()) :: binary()
  def ack(%Decision{} = decision), do: decision |> ack_frame() |> encode!()

  @spec retryable(String.t(), atom()) :: binary()
  def retryable(command_id, code)
      when is_binary(command_id) and
             code in [
               :overloaded,
               :server_draining,
               :dependency_unavailable,
               :decision_unavailable
             ] do
    encode!(%{
      "type" => "retryable_error",
      "command_id" => command_id,
      "code" => Atom.to_string(code)
    })
  end

  @spec error(atom(), String.t()) :: binary()
  def error(code, detail)
      when code in [:protocol_error, :invalid_frame, :unsupported_protocol] and is_binary(detail) do
    bounded_detail =
      binary_part(detail, 0, min(byte_size(detail), @limits["protocolErrorDetailBytes"]))

    encode!(%{"type" => "error", "code" => Atom.to_string(code), "detail" => bounded_detail})
  end

  @spec pong() :: binary()
  def pong, do: encode!(%{"type" => "pong"})

  @spec encode!(map()) :: binary()
  def encode!(frame) when is_map(frame) do
    if GeneratedV2.valid_server_frame?(frame) do
      JSON.encode!(frame)
    else
      raise ArgumentError, "invalid protocol-v2 server frame"
    end
  end

  defp normalize_client_frame({:hello, %{token: token, cursor: nil}}),
    do: {:ok, {:hello, %{token: token, cursor: nil}}}

  defp normalize_client_frame({:hello, %{token: token, cursor: cursor}}) do
    with {:ok, digest} <- decode_digest(cursor["state_digest"]) do
      {:ok,
       {:hello,
        %{
          token: token,
          cursor: %{
            revision: cursor["revision"],
            state_schema_version: cursor["state_schema_version"],
            digest: digest
          }
        }}}
    end
  end

  defp normalize_client_frame({:command, command}), do: {:ok, {:command, command}}

  defp normalize_client_frame(
         {:delivery_ack,
          %{stream: :control, revision: revision, state_digest: state_digest} = ack}
       )
       when is_integer(revision) and revision >= 1 and is_binary(state_digest),
       do: {:ok, {:delivery_ack, ack}}

  defp normalize_client_frame(
         {:recovery_ack,
          %{
            recovery_id: recovery_id,
            revision: revision,
            state_digest: state_digest
          } = ack}
       )
       when is_binary(recovery_id) and is_integer(revision) and revision >= 0 and
              is_binary(state_digest),
       do: {:ok, {:recovery_ack, ack}}

  defp normalize_client_frame(:ping), do: {:ok, :ping}

  defp decode_digest(encoded) when is_binary(encoded) do
    case Base.decode16(encoded, case: :lower) do
      {:ok, digest} when byte_size(digest) == 32 -> {:ok, digest}
      _ -> {:error, :invalid_hello}
    end
  end

  defp welcome_frame(identity, recovery, recovery_id) do
    base = %{
      "type" => "welcome",
      "protocol" => GeneratedV2.protocol_version(),
      "participant_session_id" => identity.participant_session_id,
      "participant_session_generation" => identity.participant_session_generation,
      "recovery_id" => recovery_id,
      "head" => head_frame(recovery.head),
      "mode" => Atom.to_string(recovery.mode)
    }

    case recovery.mode do
      :snapshot ->
        Map.put(base, "snapshot", snapshot_frame(recovery.snapshot, recovery.head))

      :terminal ->
        Map.put(base, "reason", Atom.to_string(recovery.terminal_reason || :session_ended))

      mode when mode in [:replay, :up_to_date] ->
        base
    end
  end

  defp recovery_complete_frame(recovery, recovery_id) do
    %{
      "type" => "recovery_complete",
      "recovery_id" => recovery_id,
      "head" => head_frame(recovery.head)
    }
  end

  defp replay_page_fits?(events, recovery_id) do
    length(events) <= @replay_page_events and
      events |> replay_page_frame(recovery_id) |> JSON.encode!() |> byte_size() <=
        @replay_page_bytes
  end

  defp replay_page_frame([first | _] = events, recovery_id) do
    %{
      "type" => "replay_page",
      "recovery_id" => recovery_id,
      "first_revision" => first["revision"],
      "last_revision" => List.last(events)["revision"],
      "events" => events
    }
  end

  defp snapshot_frame(snapshot, head) do
    Map.put(snapshot, "state_digest", digest_hex(head.digest))
  end

  defp head_frame(head) do
    %{
      "revision" => head.revision,
      "state_schema_version" => head.state_schema_version,
      "state_digest" => digest_hex(head.digest)
    }
  end

  defp event_frame(event) do
    base = %{
      "type" => "event",
      "stream" => "control",
      "name" => field(event, :name),
      "event_id" => field(event, :event_id),
      "base_revision" => field(event, :base_revision),
      "revision" => field(event, :revision),
      "schema_version" => field(event, :schema_version),
      "resulting_state_digest" => event |> field(:resulting_state_digest) |> digest_hex(),
      "payload" => field(event, :payload)
    }

    case {field(event, :command_id), field(event, :lifecycle_intent_id)} do
      {command_id, nil} when is_binary(command_id) ->
        Map.put(base, "command_id", command_id)

      {nil, lifecycle_id} when is_binary(lifecycle_id) ->
        Map.put(base, "lifecycle_intent_id", lifecycle_id)

      _ ->
        raise ArgumentError, "protocol-v2 event must have exactly one durable origin"
    end
  end

  defp ack_frame(%Decision{result: result} = decision)
       when result in [:committed, :duplicate] do
    %{
      "type" => "ack",
      "command_id" => decision.command_id,
      "result" => Atom.to_string(result),
      "event_id" => decision.event_id,
      "revision" => decision.revision
    }
  end

  defp ack_frame(%Decision{result: :command_id_conflict} = decision),
    do: rejected_ack(decision.command_id, :command_id_conflict)

  defp ack_frame(%Decision{result: :rejected} = decision),
    do: rejected_ack(decision.command_id, decision.reason)

  defp rejected_ack(command_id, reason) do
    %{
      "type" => "ack",
      "command_id" => command_id,
      "result" => "rejected",
      "reason" => Atom.to_string(reason)
    }
  end

  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp digest_hex(digest) when is_binary(digest), do: Base.encode16(digest, case: :lower)
end
