defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.RecordingOutcome do
  @moduledoc """
  Recording reservation outcomes of an external operation.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Products
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Receipts
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: SQL
  alias ChalkSync.UUID

  def finalize_recording_reservation(connection, episode, external, state) do
    case Postgrex.query!(
           connection,
           SQL.lock_recording_acceptance_event(),
           Scope.episode(episode) ++ [Scope.uuid(external.external_operation_id)]
         ).rows do
      [[event_id, revision]] ->
        event_id = UUID.load!(event_id)
        PublicationFences.delete(connection, episode, external)
        Receipts.mark_external_applied(connection, episode, external, event_id, revision)
        Receipts.commit_external_receipt(connection, episode, external, event_id, revision, state)

        applied = %{
          external
          | status: :applied,
            applied_event_id: event_id,
            applied_revision: revision
        }

        ExternalOperationDecision.build(applied, :original, state, event_id, revision)

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  def maybe_persist_recording_failure(connection, episode, external, state, failure_code)
      when external.name in [
             :start_recording,
             :stop_recording,
             :recording_capture_ready,
             :recording_capture_stopped,
             :recording_capture_failed
           ] do
    payload = %{
      "recording_id" => external.recording_id,
      "status" => "failed",
      "failure_code" => failure_code
    }

    case Reducer.apply_external(state, :recording_status_changed, payload) do
      {:ok, event, next_state} ->
        _event_id = Products.persist_event(connection, episode, external, event, next_state)
        Products.finalize_recording_product(connection, episode, external, "failed", failure_code)
        Control.notify_head(connection, episode, event.revision)
        next_state

      _ ->
        Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  def maybe_persist_recording_failure(_connection, _episode, _external, state, _failure_code),
    do: state
end
