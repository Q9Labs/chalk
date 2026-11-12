defmodule ChalkSync.Transport.SocketWhiteboardV1.Operations do
  @moduledoc """
  Whiteboard write operations a whiteboard-v1 socket submits to the Episode.

  Every operation answers with one commit frame or one operation error. A multipart update is
  assembled first and has one pending operation at a time.
  """

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Transport.SocketWhiteboardV1.Delivery
  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.Transport.SocketWhiteboardV1.Failure
  alias ChalkSync.Transport.SocketWhiteboardV1.Lifecycle
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.Multipart
  alias ChalkSync.WhiteboardV1.Protocol

  @multipart_timeout_ms GeneratedWhiteboardV1.limits()["multipartUpdateTimeoutMs"]
  @overloaded {:retryable, :overloaded}

  def submit_update(operation, %{multipart: nil} = state), do: write_update(operation, state)

  def submit_update(operation, state),
    do: Failure.operation_failure(operation.operation_id, :submit_update, @overloaded, state)

  def submit_update_part(part, state) do
    case Multipart.add(state.multipart, part) do
      {:incomplete, assembly} ->
        timer =
          state.multipart_timer ||
            Process.send_after(
              self(),
              {:whiteboard_multipart_timeout, part.operation_id},
              @multipart_timeout_ms
            )

        {:ok, %{state | multipart: assembly, multipart_timer: timer}}

      {:complete, operation} ->
        Lifecycle.cancel_timer(state.multipart_timer)
        write_update(operation, %{state | multipart: nil, multipart_timer: nil})

      failure ->
        Lifecycle.cancel_timer(state.multipart_timer)

        Failure.operation_failure(part.operation_id, :submit_update, failure, %{
          state
          | multipart: nil,
            multipart_timer: nil
        })
    end
  end

  def multipart_timeout(operation_id, %{multipart: %{operation_id: operation_id}} = state) do
    state = %{state | multipart: nil, multipart_timer: nil}
    Failure.operation_failure(operation_id, :submit_update, @overloaded, state)
  end

  def multipart_timeout(_operation_id, state), do: {:ok, state}

  def clear(operation, state), do: commit(:clear, &Episode.clear/2, operation, state)

  def set_draw_permission(operation, state),
    do: commit(:set_draw_permission, &Episode.set_draw_permission/2, operation, state)

  def set_draw_policy(operation, %{extensions: %Extensions{draw_policy: false}} = state),
    do: unavailable(:set_draw_policy, operation, state)

  def set_draw_policy(operation, state),
    do: commit(:set_draw_policy, &Episode.set_draw_policy/2, operation, state)

  def set_presentation(operation, %{extensions: %Extensions{presentation: :none}} = state),
    do: unavailable(:set_presentation, operation, state)

  def set_presentation(operation, state),
    do: commit(:set_presentation, &Episode.set_presentation/2, operation, state)

  @doc "A recovering socket refuses writes: the client retries after the snapshot."
  def refuse_while_recovering(:submit_update_part, operation, state),
    do: refuse_while_recovering(:submit_update, operation, state)

  def refuse_while_recovering(name, operation, state),
    do: Failure.operation_failure(operation.operation_id, name, @overloaded, state)

  defp write_update(operation, %{identity: identity} = state) do
    case Episode.submit_update(identity, operation) do
      {:ok, commit, updates} ->
        Enum.each(updates, &Fanout.broadcast_local(identity.episode, &1))
        state = Lifecycle.observe_operation(state, "submit_update", "committed")
        {:push, {:text, Protocol.encode!(commit)}, acknowledge_contiguous_commit(state, commit)}

      failure ->
        Failure.operation_failure(operation.operation_id, :submit_update, failure, state)
    end
  end

  defp commit(name, call, operation, %{identity: identity} = state) do
    case call.(identity, operation) do
      {:ok, commit} ->
        committed(name, commit, state)

      {:ok, commit, broadcast} ->
        Fanout.broadcast_local(identity.episode, broadcast)
        committed(name, commit, state)

      failure ->
        Failure.operation_failure(operation.operation_id, name, failure, state)
    end
  end

  defp committed(name, commit, state) do
    state = Lifecycle.observe_operation(state, Atom.to_string(name), "committed")
    {:push, {:text, Protocol.encode!(commit)}, state}
  end

  defp unavailable(name, operation, state),
    do: Failure.operation_failure(operation.operation_id, name, {:error, :unavailable}, state)

  defp acknowledge_contiguous_commit(state, commit) do
    if commit["scene_id"] == state.scene_id and
         String.to_integer(commit["revision"]) == state.revision + 1 do
      Delivery.advance_cursor(state, commit)
    else
      state
    end
  end
end
