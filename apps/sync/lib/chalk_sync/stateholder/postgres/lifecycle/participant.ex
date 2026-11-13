defmodule ChalkSync.Stateholder.Postgres.Lifecycle.Participant do
  @moduledoc """
  Locks the Participant row of a lifecycle intent and checks the intent against the product state.
  """

  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Authority, as: AuthoritySQL
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: SQL
  alias ChalkSync.UUID

  def lock_lifecycle_participant(_connection, _episode, %{name: "episode_ended"}), do: nil

  def lock_lifecycle_participant(
         connection,
         episode,
         %{name: "admission_requested", payload: payload}
       ) do
    with {:ok, admission_request_id} <- UUID.dump(payload["admission_request_id"]),
         {:ok, participant_id} <- UUID.dump(payload["participant_id"]) do
      admission_params = Scope.episode(episode) ++ [admission_request_id]

      admission =
        case Postgrex.query!(connection, SQL.lock_admission_request(), admission_params).rows do
          [
            [
              id,
              participant_id,
              display_name,
              role,
              status,
              expires_at,
              _
            ]
          ] ->
            %{
              id: UUID.load!(id),
              participant_id: UUID.load!(participant_id),
              display_name: display_name,
              role: role,
              status: status,
              expires_at: expires_at
            }

          [] ->
            Postgrex.rollback(connection, {:error, :admission_request_not_found})
        end

      participant =
        case Postgrex.query!(
               connection,
               SQL.lock_admission_participant(),
               Scope.episode(episode) ++ [participant_id]
             ).rows do
          [[generation, status, display_name, role, capabilities]] ->
            %{
              id: payload["participant_id"],
              generation: generation,
              status: status,
              display_name: display_name,
              role: role,
              capabilities: capabilities
            }

          [] ->
            Postgrex.rollback(connection, {:error, :participant_not_found})
        end

      %{admission: admission, participant: participant}
    else
      :error -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_intent})
    end
  end

  def lock_lifecycle_participant(connection, episode, intent) do
    params = Scope.episode(episode) ++ [Scope.uuid(intent.participant_id)]

    case Postgrex.query!(connection, AuthoritySQL.lock_participant(), params).rows do
      [[generation, status, role, capabilities, _identity_id]] ->
        %{generation: generation, status: status, role: role, capabilities: capabilities}

      [] ->
        Postgrex.rollback(connection, {:error, :participant_not_found})
    end
  end


  def validate_lifecycle_product_state(
         %{name: "participant_joined"} = intent,
         "active",
         participant
       ) do
    cond do
      participant.generation != intent.participant_generation ->
        {:error, :stale_participant_generation}

      participant.status != "joining" ->
        {:error, :invalid_lifecycle_transition}

      true ->
        :ok
    end
  end

  def validate_lifecycle_product_state(
         %{name: "admission_requested", payload: payload},
         "active",
         %{admission: admission, participant: participant}
       ) do
    expected_payload = %{
      "admission_request_id" => admission.id,
      "participant_id" => admission.participant_id,
      "display_name" => admission.display_name,
      "role" => admission.role,
      "expires_at_ms" => DateTime.to_unix(admission.expires_at, :millisecond)
    }

    if admission.status == "pending" and participant.status == "joining" and
         participant.id == admission.participant_id and
         participant.display_name == admission.display_name and
         participant.role == admission.role and payload == expected_payload do
      :ok
    else
      {:error, :invalid_lifecycle_transition}
    end
  end

  def validate_lifecycle_product_state(
         %{name: "participant_left"} = intent,
         "active",
         participant
       ) do
    cond do
      participant.generation != intent.participant_generation ->
        {:error, :stale_participant_generation}

      participant.status != "leaving" ->
        {:error, :invalid_lifecycle_transition}

      true ->
        :ok
    end
  end

  def validate_lifecycle_product_state(%{name: "episode_ended"}, "ending", nil), do: :ok

  def validate_lifecycle_product_state(%{name: name}, status, _participant)
       when name in ["participant_joined", "participant_left"] and status in ["ending", "ended"],
       do: {:error, :episode_ending}

  def validate_lifecycle_product_state(_intent, _status, _participant),
    do: {:error, :invalid_lifecycle_transition}


  def lifecycle_name("admission_requested"), do: :admission_requested
  def lifecycle_name("participant_joined"), do: :participant_joined
  def lifecycle_name("participant_left"), do: :participant_left
  def lifecycle_name("episode_ended"), do: :episode_ended


  def lifecycle_payload(%{name: "participant_joined", payload: payload}, participant, state) do
    payload
    |> Map.put("role", participant.role)
    |> Map.put("admission_revision", state.revision + 1)
  end

  def lifecycle_payload(intent, _participant, _state), do: intent.payload


  def normalize_lifecycle_error(:revision_gap), do: :invalid_state
  def normalize_lifecycle_error(:invalid_payload), do: :invalid_lifecycle_intent
  def normalize_lifecycle_error(:unknown_event), do: :invalid_lifecycle_intent
  def normalize_lifecycle_error(reason), do: reason
end
