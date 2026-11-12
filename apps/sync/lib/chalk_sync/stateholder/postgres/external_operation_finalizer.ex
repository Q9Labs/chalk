defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer do
  @moduledoc false

  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Outcomes
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Receipts
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Validation
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Recording
  alias ChalkSync.Stateholder.Postgres.Transaction

  @max_attempts 100
  @obsolete_target_errors [
    :participant_inactive,
    :stale_participant_generation,
    :episode_ended,
    :stale_deadline_generation
  ]

  def finalize_transaction(connection, episode, external_operation_id, outcome) do
    Transaction.configure(connection)
    control = Authority.lock_control(connection, episode)
    policy = Authority.lock_episode(connection, episode)
    external = Validation.lock_external_operation(connection, episode, external_operation_id)

    cond do
      external.status != :pending ->
        ExternalOperationDecision.build(external, :duplicate)

      ExternalOperation.leave_cleanup?(external) ->
        settle_leave_cleanup(connection, episode, external, outcome)

      Validation.stale_maximum_duration?(external, policy) ->
        settle_stale_maximum_duration(connection, episode, external)

      true ->
        case Control.validate_fold(episode, control, policy) do
          {:ok, state} ->
            finalize_with_authority(connection, episode, external, state, policy, outcome)

          {:error, reason} ->
            Postgrex.rollback(connection, {:error, reason})
        end
    end
  end

  defp finalize_with_authority(connection, episode, external, state, policy, outcome) do
    case Validation.validate_finalization_authority(connection, episode, external, policy) do
      :ok ->
        case Recording.validate_capture_epoch(connection, episode, external) do
          :ok -> Outcomes.finalize_pending_operation(connection, episode, external, state, outcome)
          {:error, reason} -> settle_capture_error(connection, episode, external, reason)
        end

      {:error, reason} ->
        settle_stale_media(connection, episode, external, state, outcome, reason)
    end
  end

  defp settle_stale_media(connection, episode, %{name: name} = external, state, outcome, reason)
       when name in [:mute_participant, :stop_participant_camera, :stop_participant_screen_share] and
              reason in [:participant_inactive, :stale_participant_generation] do
    case outcome do
      {:confirmed, :provider} ->
        Outcomes.finalize_pending_operation(connection, episode, external, state, {:failed, reason})

      {:failed, failure} when is_atom(failure) ->
        Outcomes.finalize_pending_operation(connection, episode, external, state, {:failed, reason})

      _ ->
        settle_exhausted_authority(connection, episode, external, reason)
    end
  end

  defp settle_stale_media(connection, episode, external, _state, _outcome, reason),
    do: settle_exhausted_authority(connection, episode, external, reason)

  defp settle_capture_error(connection, episode, external, :stale_recording_fence = reason)
       when external.attempt_count >= @max_attempts do
    if Recording.capture_source_pending?(connection, episode, external) do
      Postgrex.rollback(connection, {:error, reason})
    else
      settle_obsolete(connection, episode, external, reason)
    end
  end

  defp settle_capture_error(connection, _episode, _external, reason),
    do: Postgrex.rollback(connection, {:error, reason})

  defp settle_leave_cleanup(connection, episode, external, {:confirmed, :provider}) do
    Receipts.mark_external_applied(connection, episode, external, nil, nil)
    ExternalOperationDecision.build(%{external | status: :applied}, :original)
  end

  defp settle_leave_cleanup(connection, episode, external, {:failed, reason})
       when is_atom(reason) do
    Receipts.mark_external_failed(connection, episode, external, Atom.to_string(reason))

    ExternalOperationDecision.build(
      %{external | status: :failed, last_error_code: reason},
      :original
    )
  end

  defp settle_leave_cleanup(connection, _episode, _external, _outcome),
    do: Postgrex.rollback(connection, {:error, :invalid_operation_outcome})

  defp settle_stale_maximum_duration(connection, episode, external) do
    Receipts.release_failed_acceptance(connection, episode, external)
    PublicationFences.delete(connection, episode, external)
    Receipts.mark_external_failed(connection, episode, external, "stale_deadline_generation")

    failed = %{
      external
      | status: :failed,
        last_error_code: :stale_deadline_generation
    }

    ExternalOperationDecision.build(failed, :original)
  end

  defp settle_exhausted_authority(connection, episode, external, reason)
       when external.attempt_count >= @max_attempts and reason in @obsolete_target_errors,
       do: settle_obsolete(connection, episode, external, reason)

  defp settle_exhausted_authority(connection, _episode, _external, reason),
    do: Postgrex.rollback(connection, {:error, reason})

  defp settle_obsolete(
         connection,
         episode,
         %{name: :role_transition_source_stop} = external,
         reason
       ),
       do: Outcomes.finalize_pending_operation(connection, episode, external, nil, {:failed, reason})

  defp settle_obsolete(connection, episode, external, reason) do
    PublicationFences.delete(connection, episode, external)
    Receipts.mark_external_failed(connection, episode, external, Atom.to_string(reason))
    Receipts.reject_external_receipt(connection, episode, external)

    ExternalOperationDecision.build(
      %{external | status: :failed, last_error_code: reason},
      :original
    )
  end
end
