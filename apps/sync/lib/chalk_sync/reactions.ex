defmodule ChalkSync.Reactions do
  @moduledoc "Transient reaction commands for collaboration_v1."

  alias ChalkSync.Admission
  alias ChalkSync.Fanout.Collaboration
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID

  @reactions ["👍", "❤️", "😂", "😮", "😢", "🎉"]
  @reaction_ttl_ms 5_000

  @type options :: [
          repository: module(),
          fanout: GenServer.server(),
          admission: GenServer.server(),
          clock: (-> DateTime.t())
        ]

  @spec send(Identity.t(), map()) :: {:ok, map()}
  def send(%Identity{} = identity, input), do: send(identity, input, [])

  @spec send(Identity.t(), map(), options()) :: {:ok, map()}
  def send(%Identity{} = identity, %{operation_id: operation_id, reaction: reaction}, options)
      when is_binary(operation_id) and is_binary(reaction) and is_list(options) do
    with :ok <- validate_operation_id(operation_id),
         :ok <- validate_reaction(reaction),
         {:ok, profile} <- repository(options).authorize(identity, "sendReaction"),
         :ok <- Admission.admit_reaction(admission(options), identity),
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

    case Collaboration.publish_reaction(fanout(options), identity.episode, event) do
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

  defp validate_reaction(reaction),
    do: if(reaction in @reactions, do: :ok, else: {:error, :invalid_payload})

  defp validate_operation_id(value),
    do: if(byte_size(value) in 16..64, do: :ok, else: {:error, :invalid_payload})

  defp repository(options),
    do:
      Keyword.get(
        options,
        :repository,
        Application.get_env(:chalk_sync, :chat_repository, ChalkSync.Chat.Repository.Postgres)
      )

  defp admission(options),
    do: Keyword.get(options, :admission, Application.get_env(:chalk_sync, :admission, Admission))

  defp fanout(options),
    do:
      Keyword.get(
        options,
        :fanout,
        Application.get_env(:chalk_sync, :collaboration_fanout, Collaboration)
      )

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
