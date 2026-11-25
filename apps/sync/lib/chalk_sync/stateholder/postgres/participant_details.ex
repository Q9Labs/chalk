defmodule ChalkSync.Stateholder.Postgres.ParticipantDetails do
  @moduledoc false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.UUID

  @query """
  select distinct on (participants.id)
    participants.id,
    (case
      when identities.id is not null then identities.kind
      when participants.account_id is not null or participants.role = 'owner' then 'user'
      else 'guest'
    end)::text,
    participants.description
  from participants
  left join identities
    on identities.tenant_id = participants.tenant_id
    and identities.id = participants.identity_id
  where participants.tenant_id = $1
    and participants.space_id = $2
    and participants.episode_id = $3
  order by participants.id, participants.generation desc
  """

  def read(connection, %EpisodeKey{} = episode) do
    case Postgrex.query(connection, @query, Scope.episode(episode), timeout: 1_000) do
      {:ok, %{rows: rows}} -> {:ok, details_from_rows(rows)}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  end

  def read!(connection, %EpisodeKey{} = episode) do
    connection
    |> Postgrex.query!(@query, Scope.episode(episode), timeout: 1_000)
    |> Map.fetch!(:rows)
    |> details_from_rows()
  end

  defp details_from_rows(rows) do
    Map.new(rows, fn [participant_id, identity_kind, description] ->
      details = %{"identity_kind" => identity_kind}

      details =
        if is_binary(description) and description != "",
          do: Map.put(details, "description", description),
          else: details

      {UUID.load!(participant_id), details}
    end)
  end

  def overlay_snapshot(nil, _details), do: nil

  def overlay_snapshot(snapshot, details) when is_map(snapshot) and is_map(details) do
    Map.update(snapshot, "participants", [], fn participants ->
      Enum.map(participants, fn participant ->
        overlay_participant(participant, details)
      end)
    end)
  end

  def overlay_events(events, details) when is_list(events),
    do: Enum.map(events, &overlay_event(&1, details))

  def overlay_event(%{name: "participant_joined", payload: payload} = event, details)
      when is_map(payload) and is_map(details) do
    participant_id = payload["participant_id"]

    case details[participant_id] do
      nil -> event
      participant_details -> %{event | payload: Map.merge(participant_details, payload)}
    end
  end

  def overlay_event(event, _details), do: event

  defp overlay_participant(%{"participant_id" => participant_id} = participant, details) do
    case details[participant_id] do
      nil -> participant
      participant_details -> Map.merge(participant_details, participant)
    end
  end

  defp overlay_participant(participant, _details), do: participant
end
