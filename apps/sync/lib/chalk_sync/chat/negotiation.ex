defmodule ChalkSync.Chat.Negotiation do
  @moduledoc """
  Negotiates the chat and reactions extensions of a hello and shapes read-receipt frames.
  """

  alias ChalkSync.Chat.Collaborators
  alias ChalkSync.Chat.Input
  alias ChalkSync.Fanout.Collaboration
  alias ChalkSync.Stateholder.Identity

  @extension "collaboration_v1"
  @reactions_extension "collaboration_v2"

  @spec negotiate(Identity.t(), map(), pid()) :: {:ok, map()} | {:error, atom()}
  def negotiate(%Identity{} = identity, chat_cursor, socket) when is_pid(socket) do
    negotiate(identity, chat_cursor, socket, [])
  end

  @spec negotiate(Identity.t(), map(), pid(), keyword()) :: {:ok, map()} | {:error, atom()}
  def negotiate(%Identity{} = identity, negotiation, socket, options)
      when is_pid(socket) and is_list(options) do
    repository = Collaborators.repository(options)
    fanout = Collaborators.fanout(options)
    {extension, chat_cursor} = negotiation(negotiation)

    with :ok <- Input.valid_chat_cursor(chat_cursor),
         {:ok, capability_state} <- repository.participant_capabilities(identity),
         :ok <- Collaboration.subscribe(fanout, identity.episode, socket),
         {:ok, head} <- repository.head(identity.episode),
         {:ok, receipts} <- negotiated_receipts(repository, identity, extension) do
      {:ok,
       maybe_put_receipts(
         %{
           "name" => extension,
           "capabilities" => capability_state.capabilities,
           "participant_capabilities" => capability_state.participant_capabilities,
           "chat_head_sequence" => head.head_sequence,
           "retained_floor_sequence" => head.retained_floor_sequence
         },
         extension,
         receipts
       )}
    else
      {:error, reason} ->
        Collaboration.unsubscribe(fanout, identity.episode, socket)
        {:error, reason}
    end
  end

  defp negotiation(%{extension: extension} = cursor)
       when extension in [@extension, @reactions_extension] do
    {extension, Map.delete(cursor, :extension)}
  end

  defp negotiation(cursor) do
    {@extension, cursor}
  end

  defp negotiated_receipts(repository, identity, extension)
       when extension in [@extension, @reactions_extension] do
    repository.read_receipts(identity.episode)
  end

  defp maybe_put_receipts(extension, name, receipts)
       when name in [@extension, @reactions_extension] do
    Map.put(extension, "read_receipts", Enum.map(receipts, &receipt_body/1))
  end

  def receipt_frame(receipt) do
    Map.put(receipt_body(receipt), "type", "chat_read_receipt")
  end

  defp receipt_body(receipt) do
    Map.take(receipt, [:participant_id, :participant_generation, :sequence, :read_at])
    |> Map.new(fn {key, value} -> {Atom.to_string(key), value} end)
  end
end
