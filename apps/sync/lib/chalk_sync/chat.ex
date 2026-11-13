defmodule ChalkSync.Chat do
  @moduledoc "Durable Space chat commands and collaboration_v1 negotiation."
  alias ChalkSync.Chat.Collaborators
  alias ChalkSync.Chat.Input
  alias ChalkSync.Chat.Negotiation
  alias ChalkSync.Chat.Repository.Message
  alias ChalkSync.Fanout.Collaboration
  alias ChalkSync.Fanout.Collaboration.PostgresNotifications
  alias ChalkSync.Stateholder.Identity
  @type options :: [repository: module(), fanout: GenServer.server(), observability: term()]

  @spec send_chat(Identity.t(), map()) :: {:ok, map()}
  def send_chat(%Identity{} = identity, input) do
    send_chat(identity, input, [])
  end

  @spec send_chat(Identity.t(), map(), options()) :: {:ok, map()}
  def send_chat(
        %Identity{} = identity,
        %{client_message_id: client_message_id, text: text} = input,
        options
      )
      when is_binary(client_message_id) and is_binary(text) and is_list(options) do
    repository = Collaborators.repository(options)
    attachment_ids = Map.get(input, :attachment_ids, [])

    append_result =
      repository.append(
        identity,
        input
        |> Map.put(:client_message_id, client_message_id)
        |> Map.put(:text, text)
        |> Map.put(:attachment_ids, attachment_ids)
      )

    case append_result do
      {:ok, %{outcome: outcome, message: message}} ->
        if outcome == :committed do
          Collaboration.publish_chat_head(Collaborators.fanout(options), identity.episode, %{
            head_sequence: message.sequence,
            retained_floor_sequence: retained_floor(repository, identity)
          })
        end

        {:ok,
         %{
           "type" => "chat_send_result",
           "client_message_id" => client_message_id,
           "outcome" => "accepted",
           "message" => Message.wire(message, Keyword.get(options, :version, 2))
         }}

      {:error, reason} ->
        {:ok, rejected_chat(client_message_id, reason)}
    end
  end

  def send_chat(%Identity{}, input, _options) do
    client_message_id =
      if is_map(input) do
        Map.get(input, :client_message_id, "")
      else
        ""
      end

    {:ok, rejected_chat(client_message_id, :invalid_payload)}
  end

  def react(%Identity{} = identity, input, options \\ []) do
    case Collaborators.repository(options).react(identity, input) do
      {:ok, state} ->
        Collaboration.publish_chat_reactions(
          Collaborators.fanout(options),
          identity.episode,
          state
        )

        {:ok,
         %{
           "type" => "chat_reaction_result",
           "request_id" => input.request_id,
           "outcome" => "accepted",
           "state" => state
         }}

      {:error, reason} ->
        {:ok,
         %{
           "type" => "chat_reaction_result",
           "request_id" => input.request_id,
           "outcome" => "rejected",
           "error_code" => Input.error_code(reason)
         }}
    end
  end

  @spec mark_chat_read(Identity.t(), map(), options()) :: {:ok, map()}
  def mark_chat_read(identity, input, options \\ [])

  def mark_chat_read(
        %Identity{} = identity,
        %{request_id: request_id, sequence: sequence},
        options
      )
      when is_binary(request_id) and is_binary(sequence) and is_list(options) do
    repository = Collaborators.repository(options)

    with :ok <- Input.validate_operation_id(request_id),
         {:ok, result} <- repository.mark_read(identity, sequence) do
      receipt = Negotiation.receipt_frame(result.receipt)

      if result.outcome == :advanced do
        Collaboration.publish_chat_read_receipt(
          Collaborators.fanout(options),
          identity.episode,
          receipt
        )
      end

      {:ok,
       receipt
       |> Map.put("type", "chat_read_result")
       |> Map.put("request_id", request_id)
       |> Map.put("outcome", "accepted")}
    else
      {:error, reason} ->
        {:ok,
         %{
           "type" => "chat_read_result",
           "request_id" => request_id,
           "outcome" => "rejected",
           "error_code" => Input.error_code(reason)
         }}
    end
  end

  def mark_chat_read(%Identity{}, input, _options) do
    request_id =
      if is_map(input) do
        Map.get(input, :request_id, "")
      else
        ""
      end

    {:ok,
     %{
       "type" => "chat_read_result",
       "request_id" => request_id,
       "outcome" => "rejected",
       "error_code" => "invalid_payload"
     }}
  end

  @spec unsubscribe(Identity.t(), pid()) :: :ok
  def unsubscribe(%Identity{} = identity, socket) when is_pid(socket) do
    Collaboration.unsubscribe(Collaboration, identity.episode, socket)
  end

  @spec unsubscribe(Identity.t(), pid(), options()) :: :ok
  def unsubscribe(%Identity{} = identity, socket, options)
      when is_pid(socket) and is_list(options) do
    Collaboration.unsubscribe(Collaborators.fanout(options), identity.episode, socket)
  end

  @spec handle_fanout_notification(String.t(), binary()) :: :ok | {:error, :invalid_payload}
  def handle_fanout_notification(channel, payload) do
    with {:ok, {kind, episode, frame}} <-
           PostgresNotifications.decode_notification(channel, payload) do
      Collaboration.accept_external(Collaboration, kind, episode, frame)
    end
  end

  defp rejected_chat(client_message_id, reason) do
    %{
      "type" => "chat_send_result",
      "client_message_id" => client_message_id,
      "outcome" => "rejected",
      "error_code" => Input.error_code(reason)
    }
  end

  defp retained_floor(repository, identity) do
    case repository.head(identity.episode) do
      {:ok, head} -> head.retained_floor_sequence
      {:error, _reason} -> "1"
    end
  end
end
