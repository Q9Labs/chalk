defmodule ChalkSync.Transport.Socket.Commands do
  @moduledoc """
  Durable commands and operations from a live v1 socket, and the results that come back for
  them.
  """

  alias ChalkSync.Episodes.CommandIntake
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Observability
  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Transport.Socket.Frames

  def command(command, %{phase: :live, identity: identity} = state) do
    observed = Observability.observed_operation_context(state.observability)

    with {:ok, durable_command} <-
           Command.new(command.command_id, command.name, command.payload),
         durable_command = Command.observe(durable_command, observed),
         {:ok, lease} <- CommandIntake.submit(identity, durable_command) do
      {:ok, %{state | commands: Map.put(state.commands, lease, command.command_id)}}
    else
      {:error, reason} when reason in [:overloaded, :server_draining] ->
        retryable(command.command_id, reason, state)

      {:error, reason} ->
        Frames.protocol_error(reason, state)
    end
  end

  def command(_command, state), do: Frames.protocol_error(:recovery_required, state)

  def operation(operation, %{phase: :live, identity: identity} = state) do
    observed = Observability.observed_operation_context(state.observability)

    with {:ok, durable} <- Operation.new(operation.command_id, operation.name, operation.payload),
         durable = Operation.observe(durable, observed),
         {:ok, decision} <- Stateholder.begin_operation(identity, durable) do
      push(ProtocolV1.operation_decision(decision), state)
    else
      {:retryable, reason} -> retryable(operation.command_id, reason, state)
      {:error, reason} -> Frames.protocol_error(reason, state)
    end
  end

  def operation(_operation, state), do: Frames.protocol_error(:recovery_required, state)

  @doc "The result of a command the Stateholder finished: acknowledge it, or report it retryable."
  def result(command_id, result, state) do
    case result do
      {:ok, %{result: :pending, event: event}} when is_map(event) ->
        pending(command_id, event, state)

      {:ok, decision} ->
        if is_map(decision.event), do: Coordinator.publish(state.identity.episode, decision.event)
        push(ProtocolV1.ack(decision), state)

      {:retryable, reason} ->
        retryable(command_id, reason, state)
    end
  end

  defp pending(command_id, event, state) do
    case Coordinator.publish_pending(state.identity.episode, event, self()) do
      {:ok, event_frames} ->
        frames = event_frames ++ [ProtocolV1.operation_pending(command_id)]
        {:push, Enum.map(frames, &{:text, Frames.encode_with_context(state, &1)}), state}

      {:error, _reason} ->
        retryable(command_id, :dependency_unavailable, state)
    end
  end

  defp retryable(command_id, reason, state),
    do: push(ProtocolV1.retryable(command_id, reason), state)

  defp push(frame, state), do: {:push, {:text, Frames.encode_with_context(state, frame)}, state}
end
