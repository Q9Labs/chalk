defmodule ChalkSync.Transport.SocketWhiteboardV1 do
  @moduledoc "Independent whiteboard-v1 WebSocket transport."
  @behaviour WebSock
  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketContext
  alias ChalkSync.Transport.SocketWhiteboardV1.Access
  alias ChalkSync.Transport.SocketWhiteboardV1.Delivery
  alias ChalkSync.Transport.SocketWhiteboardV1.Failure
  alias ChalkSync.Transport.SocketWhiteboardV1.Hello
  alias ChalkSync.Transport.SocketWhiteboardV1.Lifecycle
  alias ChalkSync.Transport.SocketWhiteboardV1.Operations
  alias ChalkSync.Transport.SocketWhiteboardV1.Snapshot
  alias ChalkSync.Transport.SocketWhiteboardV1.Views
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Authority.Reads
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.OutboundQueue
  alias ChalkSync.WhiteboardV1.Protocol
  @hello_timeout_ms 5000
  @operations [
    :submit_update,
    :submit_update_part,
    :clear,
    :set_draw_permission,
    :set_draw_policy,
    :set_presentation
  ]

  @impl true
  def init(options) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)

    connection_attributes =
      options |> Map.new() |> Map.get(:connection_attributes, %{close_code: nil})

    observability =
      options
      |> Map.new()
      |> Map.get(:observability)
      |> Observability.merge(nil)
      |> Observability.root(
        "sync.websocket.handshake",
        Map.merge(connection_attributes, %{
          transport: "websocket",
          protocol: "whiteboard-v1"
        })
      )

    {:ok,
     %{
       phase: :awaiting_hello,
       hello_timer: timer,
       identity: nil,
       connected_at: nil,
       opened_at_ms: System.monotonic_time(:millisecond),
       last_heartbeat_at_ms: nil,
       display_name: nil,
       extensions: Extensions.none(),
       can_draw: nil,
       access: nil,
       access_timer: nil,
       access_stale: false,
       view_owner: nil,
       view_owner_ref: nil,
       scene_id: nil,
       revision: 0,
       snapshot: nil,
       pending_snapshot_requests: [],
       pending_bring: nil,
       pending_views: %{},
       awaiting_snapshot: false,
       missed_head: nil,
       multipart: nil,
       multipart_timer: nil,
       presence_windows: %{},
       outbound: OutboundQueue.new(),
       terminal: nil,
       connection_attributes: connection_attributes,
       observability: observability
     }}
  end

  @impl true
  def handle_in(payload, state) do
    with {:ok, state} <- current_authority(state), do: receive_payload(payload, state)
  end

  @impl true
  def handle_info(message, state) do
    with {:ok, state} <- current_authority(state), do: handle_message(message, state)
  end

  defp receive_payload({text, opcode: :text}, state) do
    case Protocol.decode(text) do
      {:ok, frame} ->
        handle_frame(frame, state)

      {:error, reason} ->
        Lifecycle.stop(state, 1009, Failure.close_reason(reason), :protocol_error)
    end
  end

  defp receive_payload({_payload, _options}, state) do
    Lifecycle.stop(state, 1009, "text frames only", :protocol_error)
  end

  # Fanout delivers to every subscribed socket, so a Participant who was removed or whose
  # Episode ended would keep receiving and sending live frames until it disconnected. An idle
  # board gets the same check from its tick.
  defp current_authority(%{identity: nil} = state), do: {:ok, state}

  defp current_authority(state) do
    case Authority.check(state.identity, state.connected_at) do
      :ok ->
        {:ok, state}

      {:error, {:permission_denied, denial}} ->
        {:stop, reason, close, state} =
          Lifecycle.stop(state, 1008, "policy violation", :permission_denied)

        {:stop, reason, close, put_in(state.terminal[:denial], denial)}

      {:retryable, {_reason, failure}} ->
        Lifecycle.dependency_unavailable(state, failure)
    end
  end

  defp handle_message({:DOWN, ref, :process, _pid, _reason}, %{view_owner_ref: ref} = state) do
    Lifecycle.stop(state, 1012, "view owner restarted", :view_owner_restarted)
  end

  defp handle_message(:whiteboard_authority_tick, state) do
    Process.send_after(self(), :whiteboard_authority_tick, Reads.poll_ms())
    {:ok, state}
  end

  defp handle_message(:hello_timeout, %{phase: :awaiting_hello} = state) do
    Lifecycle.stop(state, 1008, "hello timeout", :hello_timeout)
  end

  defp handle_message({:whiteboard_multipart_timeout, operation_id}, state) do
    Operations.multipart_timeout(operation_id, state)
  end

  defp handle_message({:whiteboard_v1_frame, frame}, state), do: Delivery.frame(frame, state)

  defp handle_message({:whiteboard_v1_head, scene_id, revision}, state) do
    Delivery.head(state, scene_id, revision)
  end

  defp handle_message(:whiteboard_v1_access_changed, %{phase: :live} = state) do
    Access.refresh_access(state)
  end

  defp handle_message(:whiteboard_v1_access_changed, %{phase: :recovering} = state) do
    {:ok, %{state | access_stale: true}}
  end

  defp handle_message(:whiteboard_drain, state), do: Delivery.push_next(state)

  # One queued snapshot request starts only after the outbound queue has drained.
  defp handle_message(
         :whiteboard_snapshot_next,
         %{
           phase: :live,
           terminal: nil,
           pending_snapshot_requests: [_ | _],
           outbound: %{frame_count: queued}
         } = state
       )
       when queued > 0 do
    send(self(), :whiteboard_snapshot_next)
    {:ok, state}
  end

  defp handle_message(:whiteboard_snapshot_next, %{phase: :live, terminal: nil} = state),
    do: Snapshot.next_request(state)

  defp handle_message(message, state)
       when message in [:hello_timeout, :whiteboard_v1_access_changed, :whiteboard_snapshot_next],
       do: {:ok, state}

  @impl true
  def terminate(reason, %{identity: %Identity{episode: episode}} = state) do
    Fanout.unsubscribe(episode)
    Lifecycle.observe_terminal(state, reason)
    :ok
  end

  def terminate(reason, state) do
    Lifecycle.observe_terminal(state, reason)
    :ok
  end

  defp handle_frame(
         {:hello, %{token: token, extensions: extensions, baggage: baggage}},
         %{phase: :awaiting_hello} = state
       ) do
    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, identity} <- Hello.identity(claims) do
      state
      |> Lifecycle.merge_hello_observability(baggage)
      |> SocketContext.authenticated(identity)
      |> Hello.authenticated_hello(identity, claims, extensions)
    else
      {:error, _reason} -> Lifecycle.stop(state, 1008, "invalid token", :invalid_token)
    end
  end

  defp handle_frame({:hello, _hello}, state) do
    Lifecycle.stop(state, 1008, "already authenticated", :protocol_error)
  end

  defp handle_frame({:ping, _ping}, state) do
    {:push, {:text, Protocol.pong()},
     %{state | last_heartbeat_at_ms: System.monotonic_time(:millisecond)}}
  end

  defp handle_frame({:request_snapshot, request}, %{phase: phase} = state)
       when phase in [:live, :recovering],
       do: Snapshot.request(request, state)

  defp handle_frame({:snapshot_ack, acknowledgement}, %{phase: :recovering} = state),
    do: Snapshot.acknowledge(acknowledgement, state)

  defp handle_frame({type, _frame}, %{phase: :recovering} = state)
       when type in [:cursor, :view],
       do: {:ok, state}

  defp handle_frame({name, operation}, %{phase: :recovering} = state)
       when name in @operations,
       do: Operations.refuse_while_recovering(name, operation, state)

  defp handle_frame({:submit_update, operation}, %{phase: :live} = state),
    do: Operations.submit_update(operation, state)

  defp handle_frame({:submit_update_part, part}, %{phase: :live} = state),
    do: Operations.submit_update_part(part, state)

  defp handle_frame({:clear, operation}, %{phase: :live} = state),
    do: Operations.clear(operation, state)

  defp handle_frame({:set_draw_permission, operation}, %{phase: :live} = state),
    do: Operations.set_draw_permission(operation, state)

  defp handle_frame({:set_draw_policy, operation}, %{phase: :live} = state),
    do: Operations.set_draw_policy(operation, state)

  defp handle_frame({:set_presentation, operation}, %{phase: :live} = state),
    do: Operations.set_presentation(operation, state)

  defp handle_frame({:cursor, cursor}, %{phase: :live} = state), do: Views.cursor(cursor, state)

  defp handle_frame({:view, _view}, %{phase: :live, extensions: %Extensions{view: :none}} = state),
    do: {:ok, state}

  defp handle_frame({:view, view}, %{phase: :live} = state), do: Views.view(view, state)

  defp handle_frame(_frame, state) do
    Lifecycle.stop(state, 1008, "operation not available in this phase", :protocol_error)
  end
end
