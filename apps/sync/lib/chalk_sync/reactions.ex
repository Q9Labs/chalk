defmodule ChalkSync.Reactions do
  @moduledoc "Transient reaction commands for collaboration_v1."

  alias ChalkSync.Admission
  alias ChalkSync.Chat.Collaborators
  alias ChalkSync.Fanout.Collaboration
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID

  @reactions ChalkSync.Contract.GeneratedV1.metadata()["collaboration"]["reactions"]
  # Protocol v1 clients know only these six, so the set is frozen.
  @version_1_reactions ["👍", "❤️", "😂", "😮", "😢", "🎉"]
  @reaction_ttl_ms 5_000

  @type options :: [
          repository: module(),
          fanout: GenServer.server(),
          admission: GenServer.server(),
          version: 1 | 2,
          clock: (-> DateTime.t())
        ]

  @spec send(Identity.t(), map()) :: {:ok, map()}
  def send(%Identity{} = identity, input), do: send(identity, input, [])

  @spec send(Identity.t(), map(), options()) :: {:ok, map()}
  def send(%Identity{} = identity, %{operation_id: operation_id, reaction: reaction}, options)
      when is_binary(operation_id) and is_binary(reaction) and is_list(options) do
    with :ok <- validate_operation_id(operation_id),
         :ok <- validate_reaction(reaction, options),
         {:ok, profile} <- Collaborators.repository(options).authorize(identity, "sendReaction"),
         :ok <- Admission.admit_reaction(Collaborators.admission(options), identity),
         {:ok, event} <- publish(identity, profile.display_name, reaction, options) do
      {:ok,
       %{
         "type" => "reaction_result",
         "operation_id" => operation_id,
         "outcome" => "accepted",
         "reaction" => event
       }}
    else
      {:error, reason} -> {:ok, rejected(operation_id, reason)}
    end
  end

  def send(%Identity{}, input, _options) do
    operation_id = if is_map(input), do: Map.get(input, :operation_id, ""), else: ""
    {:ok, rejected(operation_id, :invalid_payload)}
  end

  defp publish(identity, display_name, reaction, options) do
    occurred_at = Keyword.get(options, :clock, &DateTime.utc_now/0).()
    expires_at = DateTime.add(occurred_at, @reaction_ttl_ms, :millisecond)

    event = %{
      "type" => "reaction",
      "event_id" => UUID.generate(),
      "participant_id" => identity.participant_id,
      "display_name" => display_name,
      "reaction" => reaction,
      "occurred_at" => DateTime.to_iso8601(occurred_at),
      "expires_at" => DateTime.to_iso8601(expires_at)
    }

    case Collaboration.publish_reaction(Collaborators.fanout(options), identity.episode, event) do
      :ok -> {:ok, event}
      {:error, _reason} -> {:error, :dependency_unavailable}
    end
  end

  defp rejected(operation_id, reason),
    do: %{
      "type" => "reaction_result",
      "operation_id" => operation_id,
      "outcome" => "rejected",
      "error_code" => error_code(reason)
    }

  defp validate_reaction(reaction, options) do
    allowed =
      if Keyword.get(options, :version, 2) == 1,
        do: @version_1_reactions,
        else: @reactions

    if reaction in allowed, do: :ok, else: {:error, :invalid_payload}
  end

  defp validate_operation_id(value),
    do: if(byte_size(value) in 16..64, do: :ok, else: {:error, :invalid_payload})

  defp error_code(reason)
       when reason in [
              :capability_denied,
              :invalid_payload,
              :rate_limited,
              :overloaded,
              :episode_ended,
              :dependency_unavailable
            ],
       do: Atom.to_string(reason)

  defp error_code(_reason), do: "dependency_unavailable"
end
