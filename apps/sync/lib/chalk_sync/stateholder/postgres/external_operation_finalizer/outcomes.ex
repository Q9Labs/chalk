defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Outcomes do
  @moduledoc """
  Apply one external operation outcome: confirmed facts, failures and obsolete targets.
  """

  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Admission
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.ConfirmedFact
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Facts
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Receipts
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.RecordingOutcome
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Recording
  alias ChalkSync.Stateholder.Postgres.RoleTransitionSettlement

  def finalize_pending_operation(
        connection,
        episode,
        %{name: :participant_leave} = external,
        state,
        {:confirmed, :local}
      ),
      do: finalize_confirmed_operation(connection, episode, external, state)

  def finalize_pending_operation(
        connection,
        episode,
        %{name: :admit_participant} = external,
        state,
        {:confirmed, :local}
      ) do
    with {:ok, admission} <-
           Admission.lock_reserved_admission_for_external(connection, episode, external) do
      Admission.finalize_admission_approval(
        connection,
        episode,
        external,
        state,
        :participant_joined,
        Admission.admission_join_payload(admission, state)
      )
    end
  end

  def finalize_pending_operation(
        connection,
        episode,
        %{name: name} = external,
        state,
        {:confirmed, :local}
      )
      when name in [:deny_admission, :admission_request_expired, :tenant_set_deadline],
      do: finalize_confirmed_operation(connection, episode, external, state)

  def finalize_pending_operation(
        connection,
        episode,
        %{name: name} = external,
        state,
        {:confirmed, :local}
      )
      when name in [
             :recording_capture_ready,
             :recording_capture_stopped,
             :recording_capture_failed
           ],
      do: finalize_confirmed_operation(connection, episode, external, state)

  def finalize_pending_operation(
        connection,
        episode,
        %{name: name} = external,
        state,
        {:confirmed, :provider}
      )
      when name in [
             :mute_participant,
             :stop_participant_camera,
             :stop_participant_screen_share,
             :remove_participant,
             :participant_leave,
             :end_episode,
             :tenant_end_episode,
             :maximum_duration_expired
           ],
      do: finalize_confirmed_operation(connection, episode, external, state)

  def finalize_pending_operation(
        connection,
        episode,
        %{name: name} = external,
        state,
        {:confirmed, :recording}
      )
      when name in [:start_recording, :stop_recording],
      do: RecordingOutcome.finalize_recording_reservation(connection, episode, external, state)

  def finalize_pending_operation(
        connection,
        episode,
        %{name: :role_transition_source_stop} = external,
        _state,
        {:confirmed, _provider}
      ) do
    RoleTransitionSettlement.settle_child(
      connection,
      episode,
      external.external_operation_id,
      :applied
    )

    ExternalOperationDecision.build(%{external | status: :applied}, :original)
  end

  def finalize_pending_operation(
        connection,
        episode,
        %{name: :role_transition_source_stop} = external,
        _state,
        {:applied, _name, _payload}
      ) do
    RoleTransitionSettlement.settle_child(
      connection,
      episode,
      external.external_operation_id,
      :applied
    )

    ExternalOperationDecision.build(%{external | status: :applied}, :original)
  end

  def finalize_pending_operation(
        connection,
        episode,
        %{name: :role_transition_source_stop} = external,
        _state,
        {:failed, reason}
      )
      when is_atom(reason) do
    RoleTransitionSettlement.settle_child(
      connection,
      episode,
      external.external_operation_id,
      {:failed, reason}
    )

    ExternalOperationDecision.build(
      %{external | status: :failed, last_error_code: reason},
      :original
    )
  end

  def finalize_pending_operation(connection, episode, external, state, {:failed, reason})
      when is_atom(reason) do
    failure_code = Atom.to_string(reason)

    if byte_size(failure_code) > 96 do
      Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end

    state =
      RecordingOutcome.maybe_persist_recording_failure(
        connection,
        episode,
        external,
        state,
        failure_code
      )

    Receipts.release_failed_acceptance(connection, episode, external)
    PublicationFences.delete(connection, episode, external)
    Receipts.mark_external_failed(connection, episode, external, failure_code)
    Receipts.reject_external_receipt(connection, episode, external)

    failed = %{external | status: :failed, last_error_code: reason}
    ExternalOperationDecision.build(failed, :original, state)
  end

  def finalize_pending_operation(
        connection,
        episode,
        external,
        state,
        {:applied, name, payload}
      )
      when is_atom(name) and is_map(payload) do
    if external.name == :admit_participant do
      Admission.finalize_admission_approval(connection, episode, external, state, name, payload)
    else
      ConfirmedFact.finalize_external_fact(connection, episode, external, state, name, payload)
    end
  end

  def finalize_pending_operation(connection, _episode, _external, _state, _outcome),
    do: Postgrex.rollback(connection, {:error, :invalid_operation_outcome})

  defp finalize_confirmed_operation(
         connection,
         episode,
         %{name: :recording_capture_stopped} = external,
         state
       ) do
    if Recording.stopped?(connection, episode, external.recording_id) do
      Receipts.mark_external_applied(connection, episode, external, nil, nil)
      ExternalOperationDecision.build(%{external | status: :applied}, :original, state)
    else
      finalize_confirmed_operation_fact(connection, episode, external, state)
    end
  end

  defp finalize_confirmed_operation(connection, episode, external, state),
    do: finalize_confirmed_operation_fact(connection, episode, external, state)

  defp finalize_confirmed_operation_fact(connection, episode, external, state) do
    case Facts.local_operation_outcome(external, state) do
      {:ok, event_name, payload} ->
        finalize_pending_operation(
          connection,
          episode,
          external,
          state,
          {:applied, event_name, payload}
        )

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end
end
