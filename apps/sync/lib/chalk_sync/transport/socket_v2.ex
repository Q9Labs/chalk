defmodule ChalkSync.Transport.SocketV2 do
  @moduledoc "Protocol-v2 WebSocket transport over the semantic Stateholder boundary."

  @behaviour WebSock

  require Logger

  alias ChalkSync.Auth.Claims
  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.ProtocolV2
  alias ChalkSync.Sessions.CommandAdmission
  alias ChalkSync.Sessions.Coordinator
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  @hello_timeout_ms 5_000
  @heartbeat_interval_ms 20_000
  @missed_heartbeat_limit 2

  @impl true
  def init(_opts) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)

    {:ok,
     %{
       phase: :awaiting_hello,
       hello_timer: timer,
       heartbeat_timer: nil,
       missed_heartbeats: 0,
       identity: nil,
       coordinator: nil,
       commands: %{}
     }}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, state) do
    case ProtocolV2.decode(text) do
      {:ok, frame} -> handle_frame(frame, %{state | missed_heartbeats: 0})
      {:error, reason} -> close_invalid_frame(reason, state)
    end
  end

  def handle_in({_payload, _opts}, state),
    do: {:stop, :normal, {1009, "text frames only"}, state}

  @impl true
  def handle_info(:hello_timeout, %{phase: :awaiting_hello} = state),
    do: {:stop, :normal, {1008, "hello timeout"}, state}

  def handle_info(:hello_timeout, state), do: {:ok, state}

  def handle_info(:heartbeat_check, %{phase: :live} = state) do
    missed = state.missed_heartbeats + 1

    if missed >= @missed_heartbeat_limit do
      cancel_timer(state.heartbeat_timer)
      {:stop, :normal, {1001, "heartbeat timeout"}, %{state | heartbeat_timer: nil}}
    else
      {:ok,
       state
       |> Map.put(:missed_heartbeats, missed)
       |> schedule_heartbeat()}
    end
  end

  def handle_info(:heartbeat_check, state), do: {:ok, %{state | heartbeat_timer: nil}}

  def handle_info(
        {:sync_command_result, lease, command_id, result},
        %{commands: commands} = state
      ) do
    case Map.pop(commands, lease) do
      {^command_id, remaining} ->
        command_result(command_id, result, %{state | commands: remaining})

      {nil, _remaining} ->
        {:ok, state}
    end
  end

  def handle_info(
        {:sync_outbound_ready, coordinator},
        %{phase: :recovering, coordinator: coordinator} = state
      ) do
    pop_outbound(state)
  end

  def handle_info(
        {:sync_recovery_live, coordinator},
        %{phase: :recovering, coordinator: coordinator} = state
      ) do
    {:ok, state |> Map.put(:phase, :live) |> start_heartbeat()}
  end

  def handle_info({:sync_recovery_live, _coordinator}, state), do: {:ok, state}

  def handle_info(
        {:sync_recovery_advance, coordinator},
        %{phase: :recovering, coordinator: coordinator} = state
      ) do
    case Coordinator.advance_recovery(coordinator, self()) do
      :ok -> {:ok, state}
      {:error, _reason} -> {:stop, :normal, {1012, "delivery recovery required"}, state}
    end
  end

  def handle_info({:sync_recovery_advance, _coordinator}, state), do: {:ok, state}

  def handle_info(
        {:sync_outbound_ready, coordinator},
        %{phase: :live, coordinator: coordinator} = state
      ) do
    pop_outbound(state)
  end

  def handle_info(
        {:sync_outbound_overflow, _reason, _last_revision},
        state
      ) do
    {:stop, :normal, {1012, "delivery recovery required"}, state}
  end

  def handle_info({:sync_server_drained, coordinator}, %{coordinator: coordinator} = state) do
    {:stop, :normal, {1012, "server draining"}, %{state | phase: :draining}}
  end

  @impl true
  def terminate(_reason, %{coordinator: coordinator} = state) when is_pid(coordinator) do
    cancel_timer(state.heartbeat_timer)
    Coordinator.unsubscribe(coordinator, self())
    :ok
  end

  def terminate(_reason, state) do
    cancel_timer(state.heartbeat_timer)
    :ok
  end

  defp handle_frame({:hello, %{token: token, cursor: cursor}}, %{phase: :awaiting_hello} = state) do
    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, identity} <- identity(claims),
         {:ok, _lifecycle} <-
           Stateholder.apply_lifecycle_intent(
             identity.session,
             identity.admission_lifecycle_intent_id
           ),
         {:ok, coordinator} <- Coordinator.begin_recovery(identity, self()) do
      start_registered_recovery(state, identity, cursor, coordinator)
    else
      {:error, :invalid_token} ->
        {:stop, :normal, {1008, "invalid token"}, state}

      {:error, :invalid_identity} ->
        {:stop, :normal, {1008, "invalid token"}, state}

      {:error, :invalid_admission_intent} ->
        {:stop, :normal, {1008, "policy violation"}, state}

      {:error, reason} ->
        Logger.warning("sync v2 hello failed: reason=#{reason}")

        {:stop, :normal, {1012, "dependency unavailable"}, state}

      {:retryable, reason} ->
        Logger.warning("sync v2 hello retryable: #{reason}")
        {:stop, :normal, {1012, "dependency unavailable"}, state}
    end
  end

  defp handle_frame({:hello, _hello}, state), do: protocol_error(:already_authenticated, state)

  defp handle_frame(
         {:delivery_ack, %{stream: :control, revision: revision, state_digest: state_digest}},
         %{phase: :live, coordinator: coordinator} = state
       ) do
    case Coordinator.acknowledge(coordinator, revision, state_digest, self()) do
      :ok ->
        {:ok, state}

      {:error, _reason} ->
        {:stop, :normal, {1012, "delivery recovery required"}, state}
    end
  end

  defp handle_frame({:delivery_ack, _ack}, state),
    do: protocol_error(:recovery_required, state)

  defp handle_frame(
         {:recovery_ack,
          %{
            recovery_id: recovery_id,
            revision: revision,
            state_digest: state_digest
          }},
         %{phase: :recovering, coordinator: coordinator} = state
       ) do
    case Coordinator.acknowledge_recovery(
           coordinator,
           recovery_id,
           revision,
           state_digest,
           self()
         ) do
      :ok -> {:ok, state}
      {:error, _reason} -> {:stop, :normal, {1012, "delivery recovery required"}, state}
    end
  end

  defp handle_frame({:recovery_ack, _ack}, state),
    do: protocol_error(:recovery_required, state)

  defp handle_frame({:command, command}, %{phase: :live, identity: identity} = state) do
    with {:ok, durable_command} <-
           Command.new(command.command_id, command.name, command.payload),
         {:ok, lease} <- CommandAdmission.submit(identity, durable_command) do
      {:ok, %{state | commands: Map.put(state.commands, lease, command.command_id)}}
    else
      {:error, :overloaded} ->
        {:push, {:text, ProtocolV2.retryable(command.command_id, :overloaded)}, state}

      {:error, :server_draining} ->
        {:push, {:text, ProtocolV2.retryable(command.command_id, :server_draining)}, state}

      {:error, reason} ->
        protocol_error(reason, state)
    end
  end

  defp handle_frame({:command, _command}, state), do: protocol_error(:recovery_required, state)
  defp handle_frame(:ping, state), do: {:push, {:text, ProtocolV2.pong()}, state}

  defp start_registered_recovery(state, identity, cursor, coordinator) do
    with {:ok, recovery} <- Stateholder.recover(identity, cursor),
         :ok <- Coordinator.activate_recovery(coordinator, recovery, self()) do
      Process.cancel_timer(state.hello_timer)

      {:ok,
       %{
         state
         | phase: :recovering,
           hello_timer: nil,
           identity: identity,
           coordinator: coordinator
       }}
    else
      {:error, reason} ->
        Coordinator.unsubscribe(coordinator, self())
        Logger.warning("sync v2 recovery failed: reason=#{reason}")
        {:stop, :normal, {1012, "dependency unavailable"}, state}

      {:retryable, reason} ->
        Coordinator.unsubscribe(coordinator, self())
        Logger.warning("sync v2 recovery retryable: #{reason}")
        {:stop, :normal, {1012, "dependency unavailable"}, state}
    end
  end

  defp command_result(command_id, result, state) do
    case result do
      {:ok, decision} ->
        if is_map(decision.event), do: Coordinator.publish(state.identity.session, decision.event)
        {:push, {:text, ProtocolV2.ack(decision)}, state}

      {:retryable, reason} ->
        {:push, {:text, ProtocolV2.retryable(command_id, reason)}, state}
    end
  end

  defp protocol_error(reason, state),
    do: {:push, {:text, ProtocolV2.error(:protocol_error, Atom.to_string(reason))}, state}

  defp close_invalid_frame(reason, state) do
    detail =
      if(reason == :unsupported_protocol, do: "unsupported protocol", else: "invalid frame")

    code = if(reason == :unsupported_protocol, do: :unsupported_protocol, else: :invalid_frame)

    {:stop, :normal, {1009, detail}, {:text, ProtocolV2.error(code, detail)}, state}
  end

  defp identity(%Claims{} = claims) do
    with {:ok, _tenant} <- UUID.dump(claims.tenant_id),
         {:ok, _room} <- UUID.dump(claims.room_id),
         {:ok, _session} <- UUID.dump(claims.session_id),
         {:ok, _participant} <- UUID.dump(claims.participant_session_id),
         {:ok, _intent} <- UUID.dump(claims.admission_lifecycle_intent_id),
         generation when is_integer(generation) and generation > 0 <-
           claims.participant_session_generation,
         true <- valid_capabilities?(claims.capabilities) do
      {:ok,
       %Identity{
         session: %SessionKey{
           tenant_id: String.downcase(claims.tenant_id),
           room_id: String.downcase(claims.room_id),
           session_id: String.downcase(claims.session_id)
         },
         participant_session_id: String.downcase(claims.participant_session_id),
         participant_session_generation: generation,
         admission_lifecycle_intent_id: String.downcase(claims.admission_lifecycle_intent_id),
         capabilities: claims.capabilities
       }}
    else
      _ -> {:error, :invalid_identity}
    end
  end

  defp valid_capabilities?(capabilities),
    do: is_list(capabilities) and Enum.all?(capabilities, &is_binary/1)

  defp pop_outbound(%{coordinator: coordinator} = state) do
    case Coordinator.pop(coordinator, self()) do
      {:ok, encoded, false} ->
        {:push, {:text, encoded}, state}

      {:ok, encoded, true} ->
        {:stop, :normal, {1000, "terminal event drained"}, {:text, encoded},
         %{state | phase: :terminal}}

      :empty ->
        {:ok, state}

      {:error, _reason} ->
        {:stop, :normal, {1012, "delivery recovery required"}, state}
    end
  end

  defp start_heartbeat(state) do
    state
    |> Map.put(:missed_heartbeats, 0)
    |> schedule_heartbeat()
  end

  defp schedule_heartbeat(state) do
    cancel_timer(state.heartbeat_timer)
    timer = Process.send_after(self(), :heartbeat_check, @heartbeat_interval_ms)
    %{state | heartbeat_timer: timer}
  end

  defp cancel_timer(timer) when is_reference(timer), do: Process.cancel_timer(timer)
  defp cancel_timer(_timer), do: false
end
