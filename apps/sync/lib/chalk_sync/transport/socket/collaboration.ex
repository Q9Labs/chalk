defmodule ChalkSync.Transport.Socket.Collaboration do
  @moduledoc """
  The collaboration extension of a v1 socket: negotiation, buffering and ordered push of collaboration frames.
  """

  alias ChalkSync.Chat
  alias ChalkSync.Observability
  alias ChalkSync.Reactions
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.CollaborationQueue, as: CollaborationQueue
  alias ChalkSync.Transport.Socket.Frames
  alias ChalkSync.Transport.Socket.Lifecycle

  def negotiate_collaboration(_identity, nil, _observability), do: {:ok, %{}, false, nil}

  def negotiate_collaboration(identity, chat_cursor, observability) do
    case Chat.negotiate(identity, chat_cursor, self(), observability: observability) do
      {:ok, extension} ->
        {:ok, %{collaboration_extension: extension}, true,
         if(extension["name"] == "collaboration_v2", do: 2, else: 1)}

      {:error, reason} ->
        {:error, reason}
    end
  end


  def enqueue_collaboration(frame, state, kind \\ :frame) do
    encoded = Frames.encode_with_context(state, frame)

    case CollaborationQueue.push(state.collaboration_queue, encoded, kind: kind) do
      :ok ->
        push_collaboration(state)

      {:error, _reason} ->
        Lifecycle.stop(state, 1012, "space action delivery recovery required", :delivery_failure)
    end
  end


  def buffer_collaboration(frame, state) do
    encoded = Frames.encode_with_context(state, frame)

    case CollaborationQueue.push(state.collaboration_queue, encoded) do
      :ok ->
        {:ok, state}

      {:error, _reason} ->
        Lifecycle.stop(state, 1012, "space action delivery recovery required", :delivery_failure)
    end
  end


  def push_collaboration(state) do
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
        Lifecycle.stop(state, 1012, "space action delivery recovery required", :delivery_failure)

      :control_required ->
        {:ok, state}
    end
  end


  def unsubscribe_collaboration(%{
         identity: %Identity{} = identity,
         collaboration_negotiated: true
       }) do
    Chat.unsubscribe(identity, self())
  end

  def unsubscribe_collaboration(_state), do: :ok


  def observe_collaboration(state, operation, outcome) do
    observability =
      Observability.phase(state.observability, "sync.collaboration", %{
        operation: operation,
        outcome: outcome
      })

    %{state | observability: observability}
  end


  def negotiation_outcome(true), do: "negotiated"
  def negotiation_outcome(false), do: "not_requested"

  @reactions_v1 ["👍", "❤️", "😂", "😮", "😢", "🎉"]

  @doc "A collaboration frame from Fanout: drop what this socket's version cannot show."
  def frame(%{"type" => "chat_reactions"}, %{collaboration_version: version} = state)
      when version != 2,
      do: {:ok, state}

  def frame(%{"type" => "reaction", "reaction" => emoji}, %{collaboration_version: 1} = state)
      when emoji not in @reactions_v1,
      do: {:ok, state}

  def frame(%{"type" => "chat_read_receipt"}, %{collaboration_version: version} = state)
      when version not in [1, 2],
      do: {:ok, state}

  def frame(frame, %{phase: :live, collaboration_negotiated: true} = state),
    do: enqueue_collaboration(frame, state)

  def frame(
        %{"type" => type} = frame,
        %{phase: :recovering, collaboration_negotiated: true, collaboration_version: version} =
          state
      )
      when version in [1, 2] and type in ["chat_read_receipt", "chat_reactions"],
      do: buffer_collaboration(frame, state)

  def frame(_frame, state), do: {:ok, state}

  @doc "A collaboration frame from the client: reaction, chat or read receipt."
  def client_frame(name, input, %{phase: :live, collaboration_negotiated: true} = state) do
    if offered?(name, state.collaboration_version),
      do: run(name, input, state),
      else: Frames.protocol_error(:collaboration_not_negotiated, state)
  end

  def client_frame(_name, _input, state),
    do: Frames.protocol_error(:collaboration_not_negotiated, state)

  defp offered?(:chat_read_set, version), do: version in [1, 2]
  defp offered?(:chat_reaction_set, version), do: version == 2
  defp offered?(_name, _version), do: true

  defp run(:reaction_send, input, %{identity: identity} = state) do
    with {:ok, frame} <- Reactions.send(identity, input, version: state.collaboration_version) do
      deliver(frame, "reaction.send", frame["outcome"], state)
    end
  end

  defp run(:chat_read_set, input, %{identity: identity} = state) do
    with {:ok, frame} <-
           Chat.mark_chat_read(identity, input, observability: state.observability) do
      deliver(frame, "chat.read", frame["outcome"], state)
    end
  end

  defp run(:chat_reaction_set, input, %{identity: identity} = state) do
    with {:ok, frame} <- Chat.react(identity, input, observability: state.observability) do
      deliver(frame, "chat.react", frame["error_code"] || frame["outcome"], state)
    end
  end

  defp run(:chat_send, input, %{identity: identity} = state) do
    with {:ok, frame} <-
           Chat.send_chat(identity, input,
             version: state.collaboration_version,
             observability: state.observability
           ) do
      deliver(frame, "chat.send", frame["error_code"] || frame["outcome"], state)
    end
  end

  defp run(:chat_page_request, input, %{identity: identity} = state) do
    case Chat.read_chat_page(identity, input,
           version: state.collaboration_version,
           observability: state.observability
         ) do
      {:ok, frame} ->
        deliver(frame, "chat.page", frame["outcome"], state, :chat_page)

      {:error, reason} ->
        Frames.protocol_error(reason, observe_collaboration(state, "chat.page", "failed"))
    end
  end

  defp deliver(frame, operation, outcome, state, kind \\ :frame) do
    enqueue_collaboration(frame, observe_collaboration(state, operation, outcome), kind)
  end
end
