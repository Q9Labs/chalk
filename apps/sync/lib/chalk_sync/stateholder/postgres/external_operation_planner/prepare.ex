defmodule ChalkSync.Stateholder.Postgres.ExternalOperationPlanner.Prepare do
  @moduledoc """
  Checks an external operation against the current Episode, Participant and recording state and derives what the acceptance must record.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.OperationTable
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.ExternalOperationPlanner.Prepare.RecordingPolicy
  alias ChalkSync.Stateholder.Postgres.Recording
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: SQL
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: LifecycleSQL
  alias ChalkSync.UUID

  def validate_internal_operation(%{name: :start_recording, payload: payload}) do
    if RecordingPolicy.system_recording_start?(payload),
      do: :ok,
      else: {:error, :invalid_internal_operation}
  end

  def validate_internal_operation(%{name: name})
      when name in [
             :admission_request_expired,
             :tenant_set_deadline,
             :tenant_end_episode,
             :maximum_duration_expired,
             :recording_capture_ready,
             :recording_capture_stopped,
             :recording_capture_failed
           ],
      do: :ok

  def validate_internal_operation(_operation), do: {:error, :invalid_internal_operation}

  def prepare_operation(connection, identity, operation, policy, state) do
    case operation.name do
      name when name in [:admit_participant, :deny_admission] ->
        with {:ok, admission} <- lock_pending_admission(connection, identity.episode, operation) do
          {:ok, %{admission: admission, target: nil, sources: []}}
        end

      name
      when name in [
             :mute_participant,
             :stop_participant_camera,
             :stop_participant_screen_share,
             :remove_participant
           ] ->
        prepare_participant_target(connection, identity.episode, operation)

      :participant_leave ->
        target =
          Authority.lock_participant(
            connection,
            identity.episode,
            identity.participant_id
          )

        validate_leave_acceptance(state, target)

      name when name in [:start_recording, :stop_recording] ->
        RecordingPolicy.prepare_recording(connection, identity.episode, operation, policy, state)

      :end_episode ->
        prepare_end_operation(connection, identity.episode, nil)

      _ ->
        {:error, :invalid_state}
    end
  end

  def prepare_internal_operation(
        connection,
        episode,
        %{name: :start_recording} = operation,
        policy,
        state
      ),
      do: RecordingPolicy.prepare_recording(connection, episode, operation, policy, state)

  def prepare_internal_operation(
        connection,
        episode,
        %{name: :recording_capture_ready} = operation,
        _policy,
        _state
      ),
      do: Recording.prepare_capture_ready(connection, episode, operation)

  def prepare_internal_operation(
        connection,
        episode,
        %{name: :recording_capture_stopped} = operation,
        _policy,
        _state
      ),
      do: Recording.prepare_capture_stopped(connection, episode, operation)

  def prepare_internal_operation(
        connection,
        episode,
        %{name: :recording_capture_failed} = operation,
        _policy,
        _state
      ),
      do: Recording.prepare_capture_failed(connection, episode, operation)

  def prepare_internal_operation(
        connection,
        episode,
        %{name: :admission_request_expired} = op,
        _policy,
        _state
      ) do
    case lock_pending_admission(connection, episode, op) do
      {:ok, admission} ->
        params = Scope.episode(episode) ++ [Scope.uuid(admission.id)]
        due = Postgrex.query!(connection, SQL.admission_expiry_due(), params).rows == [[true]]

        if due,
          do: {:ok, %{admission: admission, target: nil, sources: []}},
          else: {:error, :invalid_state}

      error ->
        error
    end
  end

  def prepare_internal_operation(
        _connection,
        _episode,
        %{name: :tenant_set_deadline} = operation,
        policy,
        _state
      ),
      do: prepare_deadline(operation, policy)

  def prepare_internal_operation(
        connection,
        episode,
        %{name: :tenant_end_episode},
        policy,
        _state
      ) do
    if policy.status == "active" do
      prepare_end_operation(connection, episode, nil)
    else
      {:error, :episode_ended}
    end
  end

  def prepare_internal_operation(
        connection,
        episode,
        %{name: :maximum_duration_expired, payload: payload},
        policy,
        _state
      ) do
    supplied_generation = payload["deadlineGeneration"]
    due = DateTime.compare(policy.deadline_at, DateTime.utc_now()) in [:lt, :eq]

    cond do
      supplied_generation != policy.deadline_generation ->
        {:error, :stale_deadline_generation}

      policy.status != "active" || !due ->
        {:error, :episode_ended}

      true ->
        prepare_end_operation(connection, episode, supplied_generation)
    end
  end

  defp prepare_end_operation(connection, episode, deadline_generation) do
    recording_id =
      case Postgrex.query!(
             connection,
             SQL.lock_active_recording_for_end(),
             Scope.episode(episode)
           ).rows do
        [[id]] -> UUID.load!(id)
        [] -> nil
      end

    {:ok,
     %{
       target: nil,
       sources: [],
       end_episode: true,
       deadline_generation: deadline_generation,
       recording_id: recording_id
     }}
  end

  defp lock_pending_admission(connection, episode, operation) do
    request_id = operation.payload["admissionRequestId"]
    params = Scope.episode(episode) ++ [Scope.uuid(request_id)]

    case Postgrex.query!(connection, LifecycleSQL.lock_admission_request(), params).rows do
      [
        [
          id,
          participant_id,
          display_name,
          role,
          "pending",
          expires_at,
          nil
        ]
      ] ->
        {:ok,
         %{
           id: UUID.load!(id),
           participant_id: UUID.load!(participant_id),
           display_name: display_name,
           role: role,
           expires_at: expires_at
         }}

      [[_id, _participant_id, _name, _role, _status, _expires_at, _decision]] ->
        {:error, :invalid_state}

      [] ->
        {:error, :invalid_target}
    end
  end

  defp prepare_participant_target(connection, episode, operation) do
    target_id = operation.payload["participantId"]

    case Authority.lock_participant(connection, episode, target_id) do
      %{status: "active"} = target ->
        sources = OperationTable.sources(operation.name)
        {:ok, %{target: target, sources: sources}}

      _ ->
        {:error, :invalid_target}
    end
  end

  defp validate_leave_acceptance(state, %{status: "active"} = target) do
    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => target.id,
           "reason" => "left"
         }) do
      {:change, _event, _next} ->
        {:ok, %{target: target, sources: [:microphone, :camera, :screen], leave: true}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp validate_leave_acceptance(_state, _target), do: {:error, :participant_inactive}

  defp prepare_deadline(operation, policy) do
    deadline_at_ms = operation.payload["deadlineAtMs"]
    generation = operation.payload["deadlineGeneration"]

    ceiling_ms =
      DateTime.to_unix(policy.created_at, :millisecond) +
        policy.maximum_duration_ceiling_seconds * 1_000

    if generation == policy.deadline_generation + 1 and deadline_at_ms <= ceiling_ms do
      {:ok,
       %{
         target: nil,
         sources: [],
         deadline_generation: generation,
         deadline_at_ms: deadline_at_ms
       }}
    else
      {:error, :invalid_state}
    end
  end
end
