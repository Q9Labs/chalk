defmodule ChalkSync.Transport.SocketV1 do
  @moduledoc "Protocol-v1 WebSocket transport over the semantic Stateholder boundary."

  @behaviour WebSock

  require Logger

  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Observability
  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder
  alias ChalkSync.Transport.CollaborationQueue, as: CollaborationQueue
  alias ChalkSync.Transport.DirectLimits
  alias ChalkSync.Transport.Socket.Acknowledgements
  alias ChalkSync.Transport.Socket.Collaboration
  alias ChalkSync.Transport.Socket.Commands
  alias ChalkSync.Transport.Socket.Frames
  alias ChalkSync.Transport.Socket.Hello
  alias ChalkSync.Transport.Socket.Lifecycle
  alias ChalkSync.Transport.Socket.LiveRequests
  alias ChalkSync.Transport.Socket.Outbound
  alias ChalkSync.Transport.Socket.State
  alias ChalkSync.Transport.Socket.Outbound
  alias ChalkSync.Transport.Socket.State
  alias ChalkSync.Transport.Socket.State
  alias ChalkSync.Transport.SocketClose
  alias ChalkSync.Transport.SocketContext

  # Hidden, silent Chromium tabs can wake chained timers only once per minute.
  # Five checks leave at least 80 seconds since the last incoming frame.
  @missed_heartbeat_limit 5

  @impl true
  def init(opts) do
    opts = Map.new(opts)
    direct = Map.get(opts, :direct)

    # The router checked the IP before the upgrade; this reserves the slot and closes on a lost race.
    with %{ip: ip} <- direct, {:error, _denial} <- DirectLimits.register(ip) do
      send(self(), :direct_denied)
    end

    {:ok, State.awaiting_hello(opts, direct)}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, state) do
    case ProtocolV1.decode(text) do
      {:ok, frame} -> handle_frame(frame, %{state | missed_heartbeats: 0})
      {:error, reason} -> Frames.close_invalid_frame(reason, state)
    end
  end

  def handle_in({_payload, _opts}, state),
    do: Lifecycle.stop(state, 1009, "text frames only", :protocol_error)

  @impl true
  def handle_info(:hello_timeout, %{phase: :awaiting_hello} = state),
    do: Lifecycle.stop(state, 1008, "hello timeout", :hello_timeout)

  def handle_info(:hello_timeout, state), do: {:ok, state}

  def handle_info(:direct_denied, state),
    do: Lifecycle.stop(state, 1013, "try again later", :direct_limit)

  def handle_info(:entry_timeout, %{phase: :live, entry_timer: timer, identity: identity} = state)
      when not is_nil(timer) do
    case Stateholder.participant_authority(
           identity.episode,
           identity.participant_id,
           identity.participant_generation
         ) do
      {:ok, _authority} -> {:ok, %{state | entry_timer: nil}}
      {:retryable, _reason} -> Lifecycle.stop(state, 1012, "service restart", :dependency_unavailable)
      {:error, _reason} -> Lifecycle.stop(state, 1008, "entry timeout", :entry_timeout)
    end
  end

  def handle_info(:entry_timeout, state), do: {:ok, state}

  def handle_info(:heartbeat_check, %{phase: :live} = state) do
    missed = state.missed_heartbeats + 1

    if missed >= @missed_heartbeat_limit do
      Lifecycle.cancel_timer(state.heartbeat_timer)
      Lifecycle.stop(%{state | heartbeat_timer: nil}, 1001, "heartbeat timeout", :timeout)
    else
      {:ok,
       state
       |> Map.put(:missed_heartbeats, missed)
       |> Lifecycle.schedule_heartbeat()}
    end
  end

  def handle_info(:heartbeat_check, state), do: {:ok, %{state | heartbeat_timer: nil}}

  def handle_info(:renew_presence, %{phase: :live, identity: identity} = state) do
    case Stateholder.renew_presence(identity) do
      :ok -> {:ok, state}
      _ -> Lifecycle.stop(state, 1012, "service restart", :dependency_unavailable)
    end
  end

  def handle_info(:renew_presence, state), do: {:ok, state}

  def handle_info(:terminal_ack_timeout, %{phase: :terminal} = state),
    do:
      Lifecycle.stop(
        %{state | terminal_ack_timer: nil},
        1012,
        "terminal acknowledgement timeout",
        :ack_timeout
      )

  def handle_info(:terminal_ack_timeout, state),
    do: {:ok, %{state | terminal_ack_timer: nil}}

  def handle_info(
        {:sync_command_result, lease, command_id, result},
        %{commands: commands} = state
      ) do
    case Map.pop(commands, lease) do
      {^command_id, remaining} ->
        next = %{state | commands: remaining}
        Commands.result(command_id, result, next)

      {nil, _remaining} ->
        {:ok, state}
    end
  end

  def handle_info(
        {:sync_outbound_ready, coordinator},
        %{phase: :recovering, coordinator: coordinator} = state
      ) do
    Outbound.pop(state)
  end

  def handle_info(
        {:sync_v1_live_frame, coordinator, frame},
        %{coordinator: coordinator} = state
      ) do
    {:push, {:text, Frames.encode_with_context(state, frame)}, Lifecycle.mark_control_checked(state)}
  end

  def handle_info(
        {:directed_request, frame},
        %{phase: :live} = state
      ) do
    {:push, {:text, Frames.encode_with_context(state, frame)}, Lifecycle.mark_control_checked(state)}
  end

  def handle_info({:collaboration_frame, frame}, state), do: Collaboration.frame(frame, state)

  def handle_info(:collaboration_drain, state), do: Collaboration.push_collaboration(state)

  def handle_info(
        {:sync_recovery_advance, coordinator},
        %{phase: :recovering, coordinator: coordinator} = state
      ) do
    case Coordinator.advance_recovery(coordinator, self()) do
      :ok -> {:ok, state}
      {:error, _reason} -> Lifecycle.stop(state, 1012, "delivery recovery required", :delivery_failure)
    end
  end

  def handle_info({:sync_recovery_advance, _coordinator}, state), do: {:ok, state}

  def handle_info(
        {:sync_outbound_ready, coordinator},
        %{phase: :live, coordinator: coordinator} = state
      ) do
    Outbound.pop(state)
  end

  def handle_info(
        {:sync_outbound_overflow, reason, _last_revision},
        state
      ) do
    Logger.warning("sync v1 delivery recovery required: reason=#{reason}")
    Lifecycle.stop(state, 1012, "delivery recovery required", :delivery_failure)
  end

  def handle_info({:sync_server_drained, coordinator}, %{coordinator: coordinator} = state) do
    Lifecycle.stop(%{state | phase: :draining}, 1012, "server draining", :server_shutdown)
  end

  @impl true
  def terminate(reason, state) do
    Lifecycle.cancel_timer(state.heartbeat_timer)
    Lifecycle.cancel_timer(state.entry_timer)
    Lifecycle.cancel_timer(state.terminal_ack_timer)
    Collaboration.unsubscribe_collaboration(state)
    CollaborationQueue.close(state.collaboration_queue)
    if is_pid(state.coordinator), do: Coordinator.unsubscribe(state.coordinator, self())

    Observability.terminal(
      state.observability,
      "sync.websocket.closed",
      %{protocol: 1, phase: state.phase}
      |> Map.merge(state.connection_attributes)
      |> Map.merge(SocketClose.attributes(reason, state.terminal))
      |> Map.merge(Lifecycle.heartbeat_attributes(state))
    )

    :ok
  end

  defp handle_frame(
         {:hello, %{token: token, cursor: cursor} = hello},
         %{phase: :awaiting_hello} = state
       ) do
    state = Lifecycle.merge_hello_observability(state, Map.get(hello, :correlation, %{}))

    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, identity} <- Hello.identity(claims),
         :ok <- Hello.admit_direct_tenant(state, identity) do
      Hello.authenticated_hello(SocketContext.authenticated(state, identity), identity, cursor, hello)
    else
      {:error, :direct_limit} -> Lifecycle.stop(state, 1013, "try again later", :direct_limit)
      {:error, _reason} -> Lifecycle.stop(state, 1008, "invalid token", :admission_rejected)
    end
  end

  defp handle_frame({:hello, _hello}, state), do: Frames.protocol_error(:already_authenticated, state)

  defp handle_frame(:entered, %{phase: :live} = state), do: Acknowledgements.entered(state)
  defp handle_frame(:entered, state), do: Frames.protocol_error(:recovery_required, state)

  defp handle_frame({:delivery_ack, ack}, state), do: Acknowledgements.delivery_ack(ack, state)
  defp handle_frame({:recovery_ack, ack}, state), do: Acknowledgements.recovery_ack(ack, state)
  defp handle_frame({:request_ack, id}, state), do: Acknowledgements.request_ack(id, state)

  defp handle_frame({:command, command}, state), do: Commands.command(command, state)
  defp handle_frame({:operation, operation}, state), do: Commands.operation(operation, state)

  defp handle_frame({:live_target, target}, state), do: LiveRequests.live_target(target, state)

  defp handle_frame({:directed_request, request}, state),
    do: LiveRequests.directed_request(request, state)

  defp handle_frame({:connection_quality_set, quality}, state),
    do: LiveRequests.connection_quality(quality, state)

  defp handle_frame({name, input}, state)
       when name in [:reaction_send, :chat_send, :chat_page_request, :chat_read_set, :chat_reaction_set],
       do: Collaboration.client_frame(name, input, state)

  defp handle_frame(:ping, %{phase: :live} = state) do
    state = %{state | last_heartbeat_at_ms: System.monotonic_time(:millisecond)}

    # The pong leaves before the Postgres renewal so the client-measured ping is not
    # inflated by a database round trip. The renewal runs from the mailbox next.
    send(self(), :renew_presence)
    {:push, {:text, Frames.encode_with_context(state, ProtocolV1.pong())}, state}
  end

  defp handle_frame(:ping, state),
    do: {:push, {:text, Frames.encode_with_context(state, ProtocolV1.pong())}, state}
end
