defmodule ChalkSync.Stateholder.Postgres.Operations do
  @moduledoc """
  Stateholder callbacks for external operations: acceptance, claims, reads and finalization.
  """

  require Logger
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationClaims
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer
  alias ChalkSync.Stateholder.Postgres.ExternalOperationPlanner
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.Stateholder.Postgres.WebhookObservation
  alias ChalkSync.UUID

  def begin_operation(%Identity{} = identity, %Operation{} = operation) do
    case run_operation_transaction(identity, operation) do
      {:ok, %OperationDecision{} = decision} ->
        WebhookObservation.external_operation(
          identity.episode,
          decision.external_operation_id,
          decision
        )

        {:ok, decision}

      {:error, {:retryable, reason}} ->
        {:retryable, reason}

      {:error, _reason} ->
        ExternalOperationDecision.resolve_uncertain_operation(identity, operation)
    end
  rescue
    exception ->
      Logger.error(
        "sync external operation acceptance became uncertain: #{Exception.message(exception)}"
      )

      ExternalOperationDecision.resolve_uncertain_operation(identity, operation)
  catch
    :exit, reason ->
      Logger.error("sync external operation acceptance exited: #{inspect(reason)}")
      ExternalOperationDecision.resolve_uncertain_operation(identity, operation)
  end

  def begin_internal_operation(%EpisodeKey{} = episode, %Operation{} = operation) do
    case run_internal_operation_transaction(episode, operation) do
      {:ok, %OperationDecision{} = decision} ->
        WebhookObservation.external_operation(episode, decision.external_operation_id, decision)
        {:ok, decision}

      {:error, {:retryable, reason}} ->
        {:retryable, reason}

      {:error, {:error, reason}} ->
        {:error, reason}

      {:error, _reason} ->
        ExternalOperationDecision.resolve_uncertain_internal_operation(episode, operation)
    end
  rescue
    exception ->
      Logger.error(
        "sync internal operation acceptance became uncertain: #{Exception.message(exception)}"
      )

      ExternalOperationDecision.resolve_uncertain_internal_operation(episode, operation)
  catch
    :exit, reason ->
      Logger.error("sync internal operation acceptance exited: #{inspect(reason)}")
      ExternalOperationDecision.resolve_uncertain_internal_operation(episode, operation)
  end

  def claim_operations(limit) when is_integer(limit) and limit in 1..64,
    do: claim_operation_rows(&ExternalOperationClaims.claim_operations(&1, limit))

  def claim_local_operations(limit) when is_integer(limit) and limit in 1..64,
    do: claim_operation_rows(&ExternalOperationClaims.claim_local_operations(&1, limit))

  def claim_provider_operations(limit) when is_integer(limit) and limit in 1..64,
    do: claim_operation_rows(&ExternalOperationClaims.claim_provider_operations(&1, limit))

  defp claim_operation_rows(claim) do
    Database.guard(fn -> run_claim(claim) end, {:retryable, :dependency_unavailable})
  end

  defp run_claim(claim) do
    case Postgrex.transaction(Database.connection_for(:background), fn connection ->
           Transaction.configure(connection)
           claim.(connection)
         end) do
      {:ok, rows} -> {:ok, rows}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  end

  def read_operation(%EpisodeKey{} = episode, external_operation_id)
      when is_binary(external_operation_id),
      do: ExternalOperationClaims.read_operation(episode, external_operation_id)

  def finalize_operation(%EpisodeKey{} = episode, external_operation_id, outcome)
      when is_binary(external_operation_id) and is_tuple(outcome) do
    case UUID.dump(external_operation_id) do
      {:ok, _id} -> finalize_known_operation(episode, external_operation_id, outcome)
      :error -> {:error, :operation_not_found}
    end
  rescue
    exception ->
      Logger.error(
        "sync external operation finalization became uncertain: #{Exception.message(exception)}"
      )

      ExternalOperationDecision.resolve_uncertain_finalization(episode, external_operation_id)
  catch
    :exit, reason ->
      Logger.error("sync external operation finalization exited: #{inspect(reason)}")
      ExternalOperationDecision.resolve_uncertain_finalization(episode, external_operation_id)
  end

  defp finalize_known_operation(episode, external_operation_id, outcome) do
    case run_operation_finalization(episode, external_operation_id, outcome) do
      {:ok, %OperationDecision{} = decision} ->
        WebhookObservation.external_operation(episode, external_operation_id, decision)
        {:ok, decision}

      {:error, {:retryable, reason}} ->
        {:retryable, reason}

      {:error, {:error, reason}} ->
        {:error, reason}

      {:error, _reason} ->
        ExternalOperationDecision.resolve_uncertain_finalization(episode, external_operation_id)
    end
  end

  defp run_operation_transaction(identity, operation) do
    Transaction.run(
      identity.episode,
      &ExternalOperationPlanner.accept_transaction(&1, identity, operation),
      commit_comment: "chalk sync external operation acceptance"
    )
  end

  defp run_internal_operation_transaction(episode, operation) do
    Transaction.run(
      episode,
      &ExternalOperationPlanner.accept_internal_transaction(&1, episode, operation),
      commit_comment: "chalk sync internal operation acceptance"
    )
  end

  defp run_operation_finalization(episode, external_operation_id, outcome) do
    Transaction.run(
      episode,
      &ExternalOperationFinalizer.finalize_transaction(
        &1,
        episode,
        external_operation_id,
        outcome
      ),
      commit_comment: "chalk sync external operation finalization"
    )
  end
end
