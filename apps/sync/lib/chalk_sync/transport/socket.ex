defmodule ChalkSync.Transport.SocketV1 do
  @moduledoc "Protocol-v1 WebSocket transport over the semantic Stateholder boundary."

  @behaviour WebSock

  require Logger

  alias ChalkSync.Auth.Claims
  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.Chat
  alias ChalkSync.Episodes.CommandIntake
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Observability
  alias ChalkSync.ProtocolV1
  alias ChalkSync.Reactions
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Transport.CollaborationQueue, as: CollaborationQueue
  alias ChalkSync.UUID

  @hello_timeout_ms 5_000
  @heartbeat_interval_ms 20_000
  @missed_heartbeat_limit 2
  @terminal_ack_timeout_ms 5_000

  @impl true
  def init(opts) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)

    observability =
      opts
      |> Map.new()
      |> Map.get(:observability)
      |> Observability.merge(nil)
      |> Observability.root("sync.websocket.handshake", %{transport: "websocket", protocol: 1})

    {:ok,
     %{
       phase: :awaiting_hello,
       hello_timer: timer,
       heartbeat_timer: nil,
       terminal_ack_timer: nil,
       terminal_head: nil,
       missed_heartbeats: 0,
       identity: nil,
       coordinator: nil,
       commands: %{},
       collaboration_negotiated: false,
       collaboration_version: nil,
       collaboration_queue: CollaborationQueue.new(),
       observability: observability
     }}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, state) do
    case ProtocolV1.decode(text) do
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

  def handle_info(:terminal_ack_timeout, %{phase: :terminal} = state),
    do:
      {:stop, :normal, {1012, "terminal acknowledgement timeout"},
       %{state | terminal_ack_timer: nil}}

  def handle_info(:terminal_ack_timeout, state),
    do: {:ok, %{state | terminal_ack_timer: nil}}

  def handle_info(
        {:sync_command_result, lease, command_id, result},
        %{commands: commands} = state
      ) do
    case Map.pop(commands, lease) do
      {^command_id, remaining} ->
        next = %{state | commands: remaining}
        command_result(command_id, result, next)

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
    state
    |> Map.put(:phase, :live)
    |> start_heartbeat()
    |> push_collaboration()
  end

  def handle_info({:sync_recovery_live, _coordinator}, state), do: {:ok, state}

  def handle_info(
        {:sync_v1_live_frame, coordinator, frame},
        %{coordinator: coordinator} = state
      ) do
    {:push, {:text, encode_with_context(state, frame)}, mark_control_checked(state)}
  end

  def handle_info(
        {:directed_request, frame},
        %{phase: :live} = state
      ) do
    {:push, {:text, encode_with_context(state, frame)}, mark_control_checked(state)}
  end

  def handle_info(
        {:collaboration_frame, %{"type" => "chat_read_receipt"}},
        %{collaboration_version: version} = state
      )
      when version != 1,
      do: {:ok, state}

  def handle_info(
        {:collaboration_frame, frame},
        %{phase: :live, collaboration_negotiated: true} = state
      ),
      do: enqueue_collaboration(frame, state)

  def handle_info(
        {:collaboration_frame, %{"type" => "chat_read_receipt"} = frame},
        %{
          phase: :recovering,
          collaboration_negotiated: true,
          collaboration_version: 1
        } = state
      ),
      do: buffer_collaboration(frame, state)

  def handle_info({:collaboration_frame, _frame}, state), do: {:ok, state}

  def handle_info(:collaboration_drain, state), do: push_collaboration(state)

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
        {:sync_outbound_overflow, reason, _last_revision},
        state
      ) do
    Logger.warning("sync v1 delivery recovery required: reason=#{reason}")
    {:stop, :normal, {1012, "delivery recovery required"}, state}
  end

  def handle_info({:sync_server_drained, coordinator}, %{coordinator: coordinator} = state) do
    {:stop, :normal, {1012, "server draining"}, %{state | phase: :draining}}
  end

  @impl true
  def terminate(_reason, %{coordinator: coordinator} = state) when is_pid(coordinator) do
    cancel_timer(state.heartbeat_timer)
    cancel_timer(state.terminal_ack_timer)
    unsubscribe_collaboration(state)
    CollaborationQueue.close(state.collaboration_queue)
    Coordinator.unsubscribe(coordinator, self())

    Observability.terminal(state.observability, "sync.websocket.closed", %{
      protocol: 1,
      phase: state.phase
    })

    :ok
  end

  def terminate(_reason, state) do
    cancel_timer(state.heartbeat_timer)
    cancel_timer(state.terminal_ack_timer)
    unsubscribe_collaboration(state)
    CollaborationQueue.close(state.collaboration_queue)

    Observability.terminal(state.observability, "sync.websocket.closed", %{
      protocol: 1,
      phase: state.phase
    })

    :ok
  end

  defp handle_frame(
         {:hello, %{token: token, cursor: cursor} = hello},
         %{phase: :awaiting_hello} = state
       ) do
    state = merge_hello_observability(state, Map.get(hello, :correlation, %{}))

    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, identity} <- identity(claims),
         {:ok, _lifecycle} <-
           Stateholder.apply_lifecycle_intent(
             identity.episode,
             identity.admission_lifecycle_intent_id
           ),
         {:ok, protocol_options, negotiated?, collaboration_version} <-
           negotiate_collaboration(identity, Map.get(hello, :collaboration)),
         {:ok, coordinator} <-
           Coordinator.begin_recovery(identity, self(), protocol_options) do
      start_registered_recovery(
        state,
        identity,
        cursor,
        coordinator,
        negotiated?,
        collaboration_version
      )
    else
      {:error, :invalid_token} ->
        {:stop, :normal, {1008, "invalid token"}, state}

      {:error, :invalid_identity} ->
        {:stop, :normal, {1008, "invalid token"}, state}

      {:error, :invalid_admission_intent} ->
        {:stop, :normal, {1008, "policy violation"}, state}

      {:error, reason} ->
        Logger.warning("sync v1 hello failed: reason=#{reason}")

        {:stop, :normal, {1012, "dependency unavailable"}, state}

      {:retryable, reason} ->
        Logger.warning("sync v1 hello retryable: #{reason}")
        {:stop, :normal, {1012, "dependency unavailable"}, state}
    end
  end

  defp handle_frame({:hello, _hello}, state), do: protocol_error(:already_authenticated, state)

  defp handle_frame(
         {:delivery_ack, %{stream: :control, revision: revision, state_digest: state_digest}},
         %{
           phase: :terminal,
           coordinator: coordinator,
           terminal_head: %{revision: revision, state_digest: state_digest}
         } = state
       ) do
    case Coordinator.acknowledge(coordinator, revision, state_digest, self()) do
      :ok ->
        cancel_timer(state.terminal_ack_timer)

        {:stop, :normal, {1000, "terminal event acknowledged"},
         %{state | terminal_ack_timer: nil}}

      {:error, _reason} ->
        {:stop, :normal, {1012, "delivery recovery required"}, state}
    end
  end

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
    observed = Observability.observed_operation_context(state.observability)

    with {:ok, durable_command} <-
           Command.new(command.command_id, command.name, command.payload),
         durable_command = Command.observe(durable_command, observed),
         {:ok, lease} <- CommandIntake.submit(identity, durable_command) do
      {:ok, %{state | commands: Map.put(state.commands, lease, command.command_id)}}
    else
      {:error, :overloaded} ->
        {:push,
         {:text,
          encode_with_context(state, ProtocolV1.retryable(command.command_id, :overloaded))},
         state}

      {:error, :server_draining} ->
        {:push,
         {:text,
          encode_with_context(state, ProtocolV1.retryable(command.command_id, :server_draining))},
         state}

      {:error, reason} ->
        protocol_error(reason, state)
    end
  end

  defp handle_frame({:command, _command}, state), do: protocol_error(:recovery_required, state)

  defp handle_frame({:operation, operation}, %{phase: :live, identity: identity} = state) do
    observed = Observability.observed_operation_context(state.observability)

    with {:ok, durable} <- Operation.new(operation.command_id, operation.name, operation.payload),
         durable = Operation.observe(durable, observed),
         {:ok, decision} <- Stateholder.begin_operation(identity, durable) do
      {:push, {:text, encode_with_context(state, ProtocolV1.operation_decision(decision))}, state}
    else
      {:retryable, reason} ->
        {:push,
         {:text, encode_with_context(state, ProtocolV1.retryable(operation.command_id, reason))},
         state}

      {:error, reason} ->
        protocol_error(reason, state)
    end
  end

  defp handle_frame({:operation, _operation}, state),
    do: protocol_error(:recovery_required, state)

  defp handle_frame(
         {:live_target, target},
         %{
           phase: :live,
           coordinator: coordinator,
           identity: identity
         } = state
       ) do
    case Coordinator.live_target(coordinator, identity, target, self()) do
      {:ok, result} -> {:push, {:text, encode_with_context(state, result)}, state}
      {:error, reason} -> protocol_error(reason, state)
    end
  end

  defp handle_frame({:live_target, _target}, state),
    do: protocol_error(:recovery_required, state)

  defp handle_frame(
         {:directed_request, request},
         %{
           phase: :live,
           coordinator: coordinator,
           identity: identity
         } = state
       ) do
    case Coordinator.directed_request(coordinator, identity, request, self()) do
      {:ok, result} -> {:push, {:text, encode_with_context(state, result)}, state}
      {:error, reason} -> protocol_error(reason, state)
    end
  end

  defp handle_frame({:directed_request, _request}, state),
    do: protocol_error(:recovery_required, state)

  defp handle_frame(
         {:request_ack, request_id},
         %{
           phase: :live,
           coordinator: coordinator,
           identity: identity
         } = state
       ) do
    case Coordinator.acknowledge_request(coordinator, identity, request_id, self()) do
      :ok -> {:ok, state}
      {:error, reason} -> protocol_error(reason, state)
    end
  end

  defp handle_frame({:request_ack, _request_id}, state),
    do: protocol_error(:recovery_required, state)

  defp handle_frame(
         {:reaction_send, input},
         %{phase: :live, identity: identity, collaboration_negotiated: true} = state
       ) do
    with {:ok, frame} <- Reactions.send(identity, input) do
      state = observe_collaboration(state, "reaction.send", frame["outcome"])
      enqueue_collaboration(frame, state)
    end
  end

  defp handle_frame(
         {:chat_read_set, input},
         %{
           phase: :live,
           identity: identity,
           collaboration_negotiated: true,
           collaboration_version: 1
         } = state
       ) do
    with {:ok, frame} <- Chat.mark_chat_read(identity, input) do
      state = observe_collaboration(state, "chat.read", frame["outcome"])
      enqueue_collaboration(frame, state)
    end
  end

  defp handle_frame(
         {:chat_send, input},
         %{phase: :live, identity: identity, collaboration_negotiated: true} = state
       ) do
    with {:ok, frame} <-
           Chat.send_chat(identity, input, version: state.collaboration_version) do
      state = observe_collaboration(state, "chat.send", frame["outcome"])
      enqueue_collaboration(frame, state)
    end
  end

  defp handle_frame(
         {:chat_page_request, input},
         %{phase: :live, identity: identity, collaboration_negotiated: true} = state
       ) do
    case Chat.read_chat_page(identity, input, version: state.collaboration_version) do
      {:ok, frame} ->
        state = observe_collaboration(state, "chat.page", frame["outcome"])
        enqueue_collaboration(frame, state, :chat_page)

      {:error, reason} ->
        state = observe_collaboration(state, "chat.page", "failed")
        protocol_error(reason, state)
    end
  end

  defp handle_frame({name, _input}, state)
       when name in [:reaction_send, :chat_send, :chat_page_request, :chat_read_set],
       do: protocol_error(:collaboration_not_negotiated, state)

  defp handle_frame(:ping, state),
    do: {:push, {:text, encode_with_context(state, ProtocolV1.pong())}, state}

  defp start_registered_recovery(
         state,
         identity,
         cursor,
         coordinator,
         collaboration_negotiated,
         collaboration_version
       ) do
    with {:ok, recovery} <- Stateholder.recover(identity, cursor),
         :ok <-
           Coordinator.activate_recovery(
             coordinator,
             recovery,
             self(),
             recovery_timeout()
           ) do
      Process.cancel_timer(state.hello_timer)

      {:ok,
       %{
         state
         | phase: :recovering,
           hello_timer: nil,
           identity: identity,
           coordinator: coordinator,
           collaboration_negotiated: collaboration_negotiated,
           collaboration_version: collaboration_version
       }
       |> observe_collaboration(
         "extension.negotiate",
         negotiation_outcome(collaboration_negotiated)
       )}
    else
      {:error, reason} ->
        Coordinator.unsubscribe(coordinator, self())
        Logger.warning("sync v1 recovery failed: reason=#{reason}")
        {:stop, :normal, {1012, "dependency unavailable"}, state}

      {:retryable, reason} ->
        Coordinator.unsubscribe(coordinator, self())
        Logger.warning("sync v1 recovery retryable: #{reason}")
        {:stop, :normal, {1012, "dependency unavailable"}, state}
    end
  end

  defp command_result(command_id, result, state) do
    case result do
      {:ok, %{result: :pending, event: event}} when is_map(event) ->
        pending_command_result(command_id, event, state)

      {:ok, decision} ->
        if is_map(decision.event), do: Coordinator.publish(state.identity.episode, decision.event)
        {:push, {:text, encode_with_context(state, ProtocolV1.ack(decision))}, state}

      {:retryable, reason} ->
        {:push, {:text, encode_with_context(state, ProtocolV1.retryable(command_id, reason))},
         state}
    end
  end

  defp pending_command_result(command_id, event, state) do
    case Coordinator.publish_pending(state.identity.episode, event, self()) do
      {:ok, event_frames} ->
        pending = ProtocolV1.operation_pending(command_id)
        frames = Enum.map(event_frames ++ [pending], &encode_with_context(state, &1))
        {:push, Enum.map(frames, &{:text, &1}), state}

      {:error, _reason} ->
        {:push,
         {:text,
          encode_with_context(state, ProtocolV1.retryable(command_id, :dependency_unavailable))},
         state}
    end
  end

  defp merge_hello_observability(state, correlation) when is_map(correlation) do
    %{
      state
      | observability:
          Observability.merge(state.observability, Observability.context(correlation))
    }
  end

  defp merge_hello_observability(state, _correlation), do: state

  defp encode_with_context(state, frame) when is_map(frame) do
    frame
    |> Map.merge(Observability.frame_fields(state.observability))
    |> ProtocolV1.encode!()
  end

  defp encode_with_context(state, encoded) when is_binary(encoded) do
    fields = Observability.frame_fields(state.observability)

    if fields == %{} do
      encoded
    else
      encoded
      |> JSON.decode!()
      |> Map.merge(fields)
      |> ProtocolV1.encode!()
    end
  end

  defp protocol_error(reason, state),
    do:
      {:push,
       {:text,
        encode_with_context(state, ProtocolV1.error(:protocol_error, Atom.to_string(reason)))},
       state}

  defp close_invalid_frame(reason, state) do
    detail =
      if(reason == :unsupported_protocol, do: "unsupported protocol", else: "invalid frame")

    code = if(reason == :unsupported_protocol, do: :unsupported_protocol, else: :invalid_frame)

    {:stop, :normal, {1009, detail},
     {:text, encode_with_context(state, ProtocolV1.error(code, detail))}, state}
  end

  defp identity(%Claims{} = claims) do
    with {:ok, _tenant} <- UUID.dump(claims.tenant_id),
         {:ok, _space} <- UUID.dump(claims.space_id),
         {:ok, _episode} <- UUID.dump(claims.episode_id),
         {:ok, _participant} <- UUID.dump(claims.participant_id),
         {:ok, _intent} <- UUID.dump(claims.admission_lifecycle_intent_id),
         generation when is_integer(generation) and generation > 0 <-
           claims.participant_generation,
         {:ok, authorization} <- identity_authorization(claims) do
      {:ok,
       %Identity{
         episode: %EpisodeKey{
           tenant_id: String.downcase(claims.tenant_id),
           space_id: String.downcase(claims.space_id),
           episode_id: String.downcase(claims.episode_id)
         },
         participant_id: String.downcase(claims.participant_id),
         participant_generation: generation,
         admission_lifecycle_intent_id: String.downcase(claims.admission_lifecycle_intent_id),
         protocol_version: 1,
         role: authorization.role,
         capabilities: authorization.capabilities
       }}
    else
      _ -> {:error, :invalid_identity}
    end
  end

  defp identity_authorization(%Claims{} = claims) do
    if Claims.valid_authorization?(claims.role, claims.capabilities) do
      {:ok, %{role: claims.role, capabilities: claims.capabilities}}
    else
      {:error, :invalid_authorization}
    end
  end

  defp pop_outbound(%{coordinator: coordinator} = state) do
    case Coordinator.pop(coordinator, self()) do
      {:ok, encoded, false} ->
        {:push, {:text, encode_with_context(state, encoded)}, mark_control_checked(state)}

      {:ok, encoded, {:terminal, revision, state_digest}} ->
        cancel_timer(state.heartbeat_timer)
        timer = Process.send_after(self(), :terminal_ack_timeout, @terminal_ack_timeout_ms)

        {:push, {:text, encode_with_context(state, encoded)},
         %{
           state
           | phase: :terminal,
             heartbeat_timer: nil,
             terminal_ack_timer: timer,
             terminal_head: %{revision: revision, state_digest: state_digest}
         }}

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

  defp recovery_timeout do
    Application.get_env(:chalk_sync, :external_operation_adapter_timeout_ms, 5_000) + 1_000
  end

  defp negotiate_collaboration(_identity, nil), do: {:ok, %{}, false, nil}

  defp negotiate_collaboration(identity, chat_cursor) do
    case Chat.negotiate(identity, chat_cursor, self()) do
      {:ok, extension} ->
        {:ok, %{collaboration_extension: extension}, true, 1}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp enqueue_collaboration(frame, state, kind \\ :frame) do
    encoded = encode_with_context(state, frame)

    case CollaborationQueue.push(state.collaboration_queue, encoded, kind: kind) do
      :ok ->
        push_collaboration(state)

      {:error, _reason} ->
        {:stop, :normal, {1012, "space action delivery recovery required"}, state}
    end
  end

  defp buffer_collaboration(frame, state) do
    encoded = encode_with_context(state, frame)

    case CollaborationQueue.push(state.collaboration_queue, encoded) do
      :ok ->
        {:ok, state}

      {:error, _reason} ->
        {:stop, :normal, {1012, "space action delivery recovery required"}, state}
    end
  end

  defp push_collaboration(state) do
    case CollaborationQueue.take(state.collaboration_queue, false) do
      {:ok, %{encoded: encoded}} ->
        case CollaborationQueue.stats(state.collaboration_queue) do
          {:ok, %{queued_frames: queued}} when queued > 0 ->
            send(self(), :collaboration_drain)

          _other ->
            :ok
        end

        {:push, {:text, encoded}, state}

      :empty ->
        {:ok, state}

      {:error, _reason} ->
        {:stop, :normal, {1012, "space action delivery recovery required"}, state}

      :control_required ->
        {:ok, state}
    end
  end

  defp mark_control_checked(state) do
    _result = CollaborationQueue.control_checked(state.collaboration_queue)
    state
  end

  defp unsubscribe_collaboration(%{
         identity: %Identity{} = identity,
         collaboration_negotiated: true
       }) do
    Chat.unsubscribe(identity, self())
  end

  defp unsubscribe_collaboration(_state), do: :ok

  defp observe_collaboration(state, operation, outcome) do
    observability =
      Observability.phase(state.observability, "sync.collaboration", %{
        operation: operation,
        outcome: outcome
      })

    %{state | observability: observability}
  end

  defp negotiation_outcome(true), do: "negotiated"
  defp negotiation_outcome(false), do: "not_requested"
end
