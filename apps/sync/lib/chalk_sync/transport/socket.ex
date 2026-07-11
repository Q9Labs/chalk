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
  alias ChalkSync.Protocol
  alias ChalkSync.Rooms.RoomServer

  @hello_timeout_ms 10_000

  @impl true
  def init(_opts) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)
    connection_id = System.unique_integer([:positive, :monotonic])
    TraceHub.record("socket", "connected", %{"connection_id" => connection_id})

    {:ok,
     %{phase: :awaiting_hello, hello_timer: timer, claims: nil, connection_id: connection_id}}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, state) do
    case Protocol.decode(text) do
      {:ok, frame} -> handle_frame(frame, state)
      {:error, reason} -> protocol_error(reason, state)
    end
  end

  def handle_in({_payload, _opts}, state) do
    {:stop, :normal, {1003, "text frames only"}, state}
  end

  @impl true
  def handle_info({:sync_event, event}, state) do
    TraceHub.record("socket", "event_sent", %{
      "connection_id" => state.connection_id,
      "event" => event.name,
      "revision" => event.revision
    })

    {:push, {:text, Protocol.encode_event(event)}, state}
  end

  def handle_info(:hello_timeout, %{phase: :awaiting_hello} = state) do
    TraceHub.record("socket", "hello_timed_out", %{"connection_id" => state.connection_id})
    {:stop, :normal, {1002, "hello timeout"}, state}
  end

  def handle_info(:hello_timeout, state), do: {:ok, state}

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
    TraceHub.record("socket", "room_restarting", trace_context(state))
    {:stop, :normal, {1012, "room restarting"}, state}
  end

  @impl true
  def terminate(reason, state) do
    TraceHub.record(
      "socket",
      "disconnected",
      Map.put(trace_context(state), "reason", inspect(reason))
    )

    :ok
  end

  # -- Frames ------------------------------------------------------------------

  defp handle_frame({:hello, %{token: token, cursor: cursor}}, %{phase: :awaiting_hello} = state) do
    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, room_pid, reply} <-
           RoomServer.join(
             claims.room_id,
             claims.participant_id,
             claims.display_name,
             self(),
             cursor
           ) do
      Process.cancel_timer(state.hello_timer)
      Process.monitor(room_pid)
      welcome = Protocol.encode_welcome(claims.participant_id, reply)

      TraceHub.record("socket", "participant_joined", %{
        "connection_id" => state.connection_id,
        "participant_id" => claims.participant_id,
        "room_id" => claims.room_id,
        "welcome_mode" => welcome_mode(reply)
      })

      {:push, {:text, welcome}, %{state | phase: :joined, claims: claims, hello_timer: nil}}
    else
      {:error, :invalid_token} ->
        TraceHub.record("auth", "token_rejected", %{"connection_id" => state.connection_id})
        {:stop, :normal, {1008, "unauthorized"}, state}

      {:error, reason} ->
        {:stop, :normal, {1011, to_string(reason)}, state}
    end
  end

  defp handle_frame({:hello, _}, state) do
    protocol_error(:already_joined, state)
  end

  defp handle_frame({:command, command}, %{phase: :joined, claims: claims} = state) do
    result =
      RoomServer.command(
        claims.room_id,
        claims.participant_id,
        command.command_id,
        command.name,
        command.payload
      )

    TraceHub.record("command", "processed", %{
      "command" => Atom.to_string(command.name),
      "command_id" => command.command_id,
      "connection_id" => state.connection_id,
      "participant_id" => claims.participant_id,
      "result" => result_label(result),
      "room_id" => claims.room_id
    })

    {:push, {:text, Protocol.encode_ack(command.command_id, result)}, state}
  end

  defp handle_frame({:command, _}, %{phase: :awaiting_hello} = state) do
    {:stop, :normal, {1002, "hello required"}, state}
  end

  defp handle_frame(:ping, state) do
    {:push, {:text, Protocol.encode_pong()}, state}
  end

  defp protocol_error(reason, state) do
    TraceHub.record("protocol", "frame_rejected", %{
      "connection_id" => state.connection_id,
      "reason" => to_string(reason)
    })

    {:push, {:text, Protocol.encode_error(:protocol_error, to_string(reason))}, state}
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
end
