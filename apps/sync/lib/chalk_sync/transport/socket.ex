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
  alias ChalkSync.Protocol
  alias ChalkSync.Rooms.RoomServer

  @hello_timeout_ms 10_000

  @impl true
  def init(_opts) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)
    {:ok, %{phase: :awaiting_hello, hello_timer: timer, claims: nil}}
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
    {:push, {:text, Protocol.encode_event(event)}, state}
  end

  def handle_info(:hello_timeout, %{phase: :awaiting_hello} = state) do
    {:stop, :normal, {1002, "hello timeout"}, state}
  end

  def handle_info(:hello_timeout, state), do: {:ok, state}

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
    {:stop, :normal, {1012, "room restarting"}, state}
  end

  @impl true
  def terminate(_reason, _state), do: :ok

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
      {:push, {:text, welcome}, %{state | phase: :joined, claims: claims, hello_timer: nil}}
    else
      {:error, :invalid_token} -> {:stop, :normal, {1008, "unauthorized"}, state}
      {:error, reason} -> {:stop, :normal, {1011, to_string(reason)}, state}
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

    {:push, {:text, Protocol.encode_ack(command.command_id, result)}, state}
  end

  defp handle_frame({:command, _}, %{phase: :awaiting_hello} = state) do
    {:stop, :normal, {1002, "hello required"}, state}
  end

  defp handle_frame(:ping, state) do
    {:push, {:text, Protocol.encode_pong()}, state}
  end

  defp protocol_error(reason, state) do
    {:push, {:text, Protocol.encode_error(:protocol_error, to_string(reason))}, state}
  end
end
