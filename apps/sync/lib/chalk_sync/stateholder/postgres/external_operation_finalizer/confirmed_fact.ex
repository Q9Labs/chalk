defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.ConfirmedFact do
  @moduledoc """
  Write a confirmed external fact: event, products, receipt and the media stop it implies.
  """

  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Facts
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Products
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Receipts
  alias ChalkSync.Stateholder.Postgres.MediaPauses
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: SQL
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.Producer, as: WebhookProducer

  @stop_sources %{
    "participant_microphone_stopped" => :microphone,
    "participant_camera_stopped" => :camera,
    "participant_screen_share_stopped" => :screen
  }

  def finalize_external_fact(connection, episode, external, state, name, payload) do
    case Facts.expected_external_fact(external, state, name, payload) do
      {:ok, event, next_state} ->
        event_id = Products.persist_event(connection, episode, external, event, next_state)
        record_media_stop(connection, episode, external, event)

        webhook_object =
          Products.update_external_products(connection, episode, external, event, next_state)

        enqueue_leave_cleanup(connection, episode, external)
        PublicationFences.delete(connection, episode, external)
        Receipts.mark_external_applied(connection, episode, external, event_id, event.revision)

        Receipts.commit_external_receipt(
          connection,
          episode,
          external,
          event_id,
          event.revision,
          next_state
        )

        WebhookProducer.produce_external(connection, episode, external, event, webhook_object)
        Control.notify_head(connection, episode, event.revision)

        applied = %{
          external
          | status: :applied,
            applied_event_id: event_id,
            applied_revision: event.revision
        }

        ExternalOperationDecision.build(applied, :original, next_state)

      {:error, _reason} ->
        Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  defp record_media_stop(connection, episode, external, %{name: name} = event) do
    case Map.fetch(@stop_sources, to_string(name)) do
      {:ok, source} ->
        MediaPauses.record_stop(
          connection,
          episode,
          external.target_participant_id,
          source,
          event.revision
        )

      :error ->
        :ok
    end
  end

  defp enqueue_leave_cleanup(connection, episode, %{name: :participant_leave} = external) do
    Postgrex.query!(
      connection,
      SQL.insert_leave_cleanup(),
      Scope.episode(episode) ++
        [Scope.uuid(external.external_operation_id), Scope.uuid(UUID.generate())]
    )
  end

  defp enqueue_leave_cleanup(_connection, _episode, _external), do: :ok
end
