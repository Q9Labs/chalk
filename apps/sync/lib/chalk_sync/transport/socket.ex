defmodule ChalkSync.Transport.Socket do
  @moduledoc """
  WebSocket transport: one process per connection, stateless fanout.

  Owns no authoritative state — it verifies the participant token, joins the
  room's authoritative writer, relays frames, and pushes room events. If the
  room server dies, the socket closes (1012) so the client reconnects and
  re-snapshots; nothing authoritative is lost.
  """

  @behaviour WebSock

  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.DevTools.TraceHub
  alias ChalkSync.Observability
  alias ChalkSync.Protocol
  alias ChalkSync.Rooms.RoomServer

  @hello_timeout_ms 10_000
  @protocol_reasons %{
    malformed_json: "malformed_json",
    missing_type: "missing_type",
    unknown_type: "unknown_type",
    invalid_command: "invalid_command",
    unknown_command: "unknown_command",
    invalid_payload: "invalid_payload",
    invalid_cursor: "invalid_cursor",
    unsupported_protocol: "unsupported_protocol"
  }

  @impl true
  def init(opts) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)
    connection_id = System.unique_integer([:positive, :monotonic])
    TraceHub.record("socket", "connected", %{"connection_id" => connection_id})

    state = %{
      phase: :awaiting_hello,
      hello_timer: timer,
      claims: nil,
      connection_id: connection_id,
      observability: Map.get(opts, :observability),
      close: nil
    }

    {:ok, observe_handshake(state)}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, state) do
    case Protocol.decode_with_context(text) do
      {:ok, frame, frame_context} -> handle_frame(frame, ensure_observation(state, frame_context))
      {:error, reason} -> protocol_error(reason, ensure_observation(state, nil))
    end
  end

  def handle_in({_payload, _opts}, state) do
    state =
      state
      |> ensure_observation(nil)
      |> observe_phase("sync.protocol.rejected", %{"reason" => "non_text"})

    close(state, 1003, "text frames only")
  end

  @impl true
  def handle_info({:sync_event, event, originating_context}, state) do
    event_context =
      Observability.phase(originating_context, "sync.broadcast.sent", %{
        event_name: event.name
      })

    TraceHub.record("socket", "event_sent", %{
      "connection_id" => state.connection_id,
      "event" => event.name,
      "revision" => event.revision
    })

    {:push, {:text, Protocol.encode_event(event, event_context)}, state}
  end

  def handle_info(:hello_timeout, %{phase: :awaiting_hello} = state) do
    state =
      state
      |> ensure_observation(nil)
      |> observe_phase("sync.hello.timeout", %{})

    TraceHub.record("socket", "hello_timed_out", %{"connection_id" => state.connection_id})
    close(state, 1002, "hello timeout")
  end

  def handle_info(:hello_timeout, state), do: {:ok, state}

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
    state = observe_phase(state, "sync.room.recovery", %{outcome: "reconnect_required"})
    TraceHub.record("socket", "room_restarting", trace_context(state))
    close(state, 1012, "room restarting")
  end

  @impl true
  def terminate(reason, state) do
    context =
      state.observability
      |> Observability.terminal("sync.connection.closed", close_attributes(state, reason))

    TraceHub.record(
      "socket",
      "disconnected",
      Map.put(trace_context(state), "reason", inspect(reason))
    )

    _ = context
    :ok
  end

  # -- Frames ------------------------------------------------------------------

  defp handle_frame({:hello, %{token: token, cursor: cursor}}, %{phase: :awaiting_hello} = state) do
    state = observe_phase(state, "sync.hello.received", %{})

    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, room_pid, reply} <-
           RoomServer.join(
             claims.room_id,
             claims.participant_id,
             claims.display_name,
             self(),
             cursor,
             state.observability
           ) do
      Process.cancel_timer(state.hello_timer)
      Process.monitor(room_pid)

      state =
        state
        |> observe_phase("sync.auth.accepted", %{})
        |> observe_phase("sync.room.joined", %{welcome_mode: welcome_mode_label(reply)})

      welcome = Protocol.encode_welcome(claims.participant_id, reply, state.observability)

      TraceHub.record("socket", "participant_joined", %{
        "connection_id" => state.connection_id,
        "participant_id" => claims.participant_id,
        "room_id" => claims.room_id,
        "welcome_mode" => welcome_mode(reply)
      })

      {:push, {:text, welcome}, %{state | phase: :joined, claims: claims, hello_timer: nil}}
    else
      {:error, :invalid_token} ->
        state = observe_phase(state, "sync.auth.rejected", %{reason: "invalid_token"})
        TraceHub.record("auth", "token_rejected", %{"connection_id" => state.connection_id})
        close(state, 1008, "unauthorized")

      {:error, reason} ->
        state = observe_phase(state, "sync.hello.failed", %{reason: error_label(reason)})
        close(state, 1011, "internal room error")
    end
  end

  defp handle_frame({:hello, _}, state) do
    protocol_error(:already_joined, state)
  end

  defp handle_frame({:command, command}, %{phase: :joined, claims: claims} = state) do
    state =
      observe_phase(state, "sync.command.received", %{command_name: Atom.to_string(command.name)})

    result =
      RoomServer.command(
        claims.room_id,
        claims.participant_id,
        command.command_id,
        command.name,
        command.payload,
        state.observability
      )

    state = observe_phase(state, "sync.command.ack", %{result: result_outcome(result)})

    TraceHub.record("command", "processed", %{
      "command" => Atom.to_string(command.name),
      "command_id" => command.command_id,
      "connection_id" => state.connection_id,
      "participant_id" => claims.participant_id,
      "result" => result_label(result),
      "room_id" => claims.room_id
    })

    {:push, {:text, Protocol.encode_ack(command.command_id, result, state.observability)}, state}
  end

  defp handle_frame({:command, _}, %{phase: :awaiting_hello} = state) do
    state = observe_phase(state, "sync.hello.required", %{})
    close(state, 1002, "hello required")
  end

  defp handle_frame({:ping, _correlation_fields}, state) do
    {:push, {:text, Protocol.encode_pong(state.observability)}, state}
  end

  defp protocol_error(reason, state) do
    state = observe_phase(state, "sync.protocol.rejected", %{reason: protocol_reason(reason)})

    TraceHub.record("protocol", "frame_rejected", %{
      "connection_id" => state.connection_id,
      "reason" => to_string(reason)
    })

    {:push,
     {:text, Protocol.encode_error(:protocol_error, to_string(reason), state.observability)},
     state}
  end

  defp observe_handshake(%{observability: nil} = state), do: state

  defp observe_handshake(state) do
    observe_root(state, "sync.websocket.handshake", %{transport: "websocket"})
  end

  defp ensure_observation(state, frame_context) do
    fresh_connection? = is_nil(state.observability)
    context = Observability.merge(state.observability, frame_context)
    state = %{state | observability: context}

    if fresh_connection? do
      observe_root(state, "sync.websocket.handshake", %{transport: "websocket"})
    else
      state
    end
  end

  defp observe_root(state, name, attributes) do
    %{state | observability: Observability.root(state.observability, name, attributes)}
  end

  defp observe_phase(state, name, attributes) do
    %{state | observability: Observability.phase(state.observability, name, attributes)}
  end

  defp close(state, code, reason) do
    {:stop, :normal, {code, reason}, %{state | close: %{code: code, reason: reason}}}
  end

  defp trace_context(%{claims: nil} = state),
    do: %{"connection_id" => state.connection_id}

  defp trace_context(state) do
    %{
      "connection_id" => state.connection_id,
      "participant_id" => state.claims.participant_id,
      "room_id" => state.claims.room_id
    }
  end

  defp result_label({result, value}), do: "#{result}:#{value}"
  defp welcome_mode(%{snapshot: %{}}), do: "snapshot"
  defp welcome_mode(%{replay: events}), do: "replay (#{length(events)} events)"
  defp welcome_mode_label(%{snapshot: %{}}), do: "snapshot"
  defp welcome_mode_label(%{replay: _events}), do: "replay"
  defp result_outcome({result, _value}), do: Atom.to_string(result)

  defp protocol_reason(reason), do: Map.get(@protocol_reasons, reason, "invalid_frame")

  defp error_label(:retry), do: "retry"
  defp error_label(:revision_conflict), do: "revision_conflict"
  defp error_label(_reason), do: "internal"

  defp close_attributes(%{close: %{code: code, reason: reason}}, _termination_reason) do
    %{close_code: Integer.to_string(code), close_reason: close_reason_label(reason)}
  end

  defp close_attributes(_state, :normal), do: %{close_code: "peer", close_reason: "peer_closed"}

  defp close_attributes(_state, _reason),
    do: %{close_code: "internal", close_reason: "terminated"}

  defp close_reason_label("hello timeout"), do: "hello_timeout"
  defp close_reason_label("hello required"), do: "hello_required"
  defp close_reason_label("text frames only"), do: "non_text"
  defp close_reason_label("unauthorized"), do: "unauthorized"
  defp close_reason_label("internal room error"), do: "internal_room_error"
  defp close_reason_label("room restarting"), do: "room_restarting"
  defp close_reason_label(_reason), do: "closed"
end
