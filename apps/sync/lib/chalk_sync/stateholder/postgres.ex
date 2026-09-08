defmodule ChalkSync.Stateholder.Postgres do
  @moduledoc """
  PostgreSQL authority for atomic control decisions and recovery reads.

  The facade owns every semantic transaction boundary. Cohesive persistence
  modules receive the live transaction connection and cannot split a decision
  across transactions.
  """

  @behaviour ChalkSync.Stateholder

  require Logger

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Postgres.CommandDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationClaims
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer
  alias ChalkSync.Stateholder.Postgres.ExternalOperationPlanner
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.Stateholder.Postgres.Lifecycle
  alias ChalkSync.Stateholder.Postgres.ParticipantAuthority
  alias ChalkSync.Stateholder.Postgres.PublicationGrants
  alias ChalkSync.Stateholder.Postgres.RecoveryReader
  alias ChalkSync.Stateholder.Postgres.RoleTransitionPlanner
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.Stateholder.Postgres.WebhookObservation
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.UUID

  @transaction_timeout_ms 3_000

  @impl ChalkSync.Stateholder
  def decide_command(%Identity{} = identity, %Command{} = command) do
    FaultHooks.command(:before_transaction, identity, command)

    case run_decision_transaction(identity, command) do
      {:ok, decision} ->
        FaultHooks.command(:after_commit_before_reply, identity, command)
        {:ok, decision}

      {:error, {:retryable, reason}} ->
        {:retryable, reason}

      {:error, _reason} ->
        CommandDecision.resolve_uncertain(identity, command)
    end
  rescue
    exception ->
      Logger.error("sync decision transaction became uncertain: #{Exception.message(exception)}")
      CommandDecision.resolve_uncertain(identity, command)
  catch
    :exit, reason ->
      Logger.error("sync decision transaction exited before resolution: #{inspect(reason)}")
      CommandDecision.resolve_uncertain(identity, command)
  end

  @impl ChalkSync.Stateholder
  def resolve_receipt(%Identity{} = identity, %Command{} = command),
    do: CommandDecision.resolve_receipt(identity, command)

  @impl ChalkSync.Stateholder
  def apply_lifecycle_intent(%EpisodeKey{} = episode, lifecycle_intent_id)
      when is_binary(lifecycle_intent_id) do
    case UUID.dump(lifecycle_intent_id) do
      {:ok, _uuid} ->
        case run_lifecycle_transaction(episode, lifecycle_intent_id) do
          {:ok, %LifecycleDecision{} = decision} ->
            FaultHooks.lifecycle(:after_commit_before_reply, episode, lifecycle_intent_id)
            WebhookObservation.lifecycle(episode, lifecycle_intent_id, decision)
            {:ok, decision}

          {:error, {:retryable, reason}} ->
            {:retryable, reason}

          {:error, {:error, reason}} ->
            {:error, reason}

          {:error, _reason} ->
            Lifecycle.resolve_uncertain(episode, lifecycle_intent_id)
        end

      :error ->
        {:error, :invalid_lifecycle_intent_id}
    end
  rescue
    exception ->
      Logger.error("sync lifecycle transaction became uncertain: #{Exception.message(exception)}")
      Lifecycle.resolve_uncertain(episode, lifecycle_intent_id)
  catch
    :exit, reason ->
      Logger.error("sync lifecycle transaction exited before resolution: #{inspect(reason)}")
      Lifecycle.resolve_uncertain(episode, lifecycle_intent_id)
  end

  @impl ChalkSync.Stateholder
  def record_lifecycle_failure(%EpisodeKey{} = episode, lifecycle_intent_id, reason)
      when is_binary(lifecycle_intent_id) and is_atom(reason),
      do: Lifecycle.record_lifecycle_failure(episode, lifecycle_intent_id, reason)

  @impl ChalkSync.Stateholder
  def pending_lifecycle_intents(limit) when is_integer(limit) and limit in 1..64,
    do: Lifecycle.pending_lifecycle_intents(limit)

  @impl ChalkSync.Stateholder
  def begin_operation(%Identity{} = identity, %Operation{} = operation) do
    case run_operation_transaction(identity, operation) do
      {:ok, %OperationDecision{} = decision} ->
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

  @impl ChalkSync.Stateholder
  def begin_internal_operation(%EpisodeKey{} = episode, %Operation{} = operation) do
    case run_internal_operation_transaction(episode, operation) do
      {:ok, %OperationDecision{} = decision} ->
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

  @impl ChalkSync.Stateholder
  def claim_operations(limit) when is_integer(limit) and limit in 1..64,
    do: ExternalOperationClaims.claim_operations(limit)

  @impl ChalkSync.Stateholder
  def claim_local_operations(limit) when is_integer(limit) and limit in 1..64,
    do: ExternalOperationClaims.claim_local_operations(limit)

  @impl ChalkSync.Stateholder
  def read_operation(%EpisodeKey{} = episode, external_operation_id)
      when is_binary(external_operation_id),
      do: ExternalOperationClaims.read_operation(episode, external_operation_id)

  @impl ChalkSync.Stateholder
  def participant_authority(%EpisodeKey{} = episode, participant_id, expected_generation)
      when is_binary(participant_id) and
             (is_nil(expected_generation) or
                (is_integer(expected_generation) and expected_generation > 0)),
      do: ParticipantAuthority.participant_authority(episode, participant_id, expected_generation)

  @impl ChalkSync.Stateholder
  def reserve_publication_grant(%Identity{} = identity, operation_id, source)
      when is_binary(operation_id) and source in [:microphone, :camera, :screen] do
    case Postgrex.transaction(
           Database.connection(identity.episode),
           &PublicationGrants.reserve_transaction(&1, identity, operation_id, source),
           timeout: @transaction_timeout_ms,
           commit_comment: "chalk sync publication grant reservation"
         ) do
      {:ok, reservation} -> {:ok, reservation}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  def reserve_publication_grant(_identity, _operation_id, _source),
    do: {:error, :invalid_operation}

  @impl ChalkSync.Stateholder
  def complete_publication_grant(%EpisodeKey{} = episode, reservation_id, outcome)
      when is_binary(reservation_id) do
    case UUID.dump(reservation_id) do
      {:ok, _id} -> complete_publication_grant(episode, reservation_id, outcome, :valid)
      :error -> {:error, :reservation_not_found}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  defp complete_publication_grant(episode, reservation_id, outcome, :valid) do
    case Postgrex.transaction(
           Database.connection(episode),
           &PublicationGrants.complete_transaction(&1, episode, reservation_id, outcome),
           timeout: @transaction_timeout_ms,
           commit_comment: "chalk sync publication grant completion"
         ) do
      {:ok, result} -> {:ok, result}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  end

  @impl ChalkSync.Stateholder
  def begin_role_transition(%Identity{} = identity, %Command{} = command, publications)
      when command.name in [:assign_roles] and is_list(publications) do
    case Postgrex.transaction(
           Database.connection(identity.episode),
           &RoleTransitionPlanner.transaction(&1, identity, command, publications),
           timeout: @transaction_timeout_ms,
           commit_comment: "chalk sync role transition"
         ) do
      {:ok, decision} -> {:ok, decision}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> CommandDecision.resolve_uncertain(identity, command)
    end
  rescue
    _exception -> CommandDecision.resolve_uncertain(identity, command)
  catch
    :exit, _reason -> CommandDecision.resolve_uncertain(identity, command)
  end

  def begin_role_transition(%Identity{} = identity, %Command{} = command, _publications),
    do: decide_command(identity, command)

  @impl ChalkSync.Stateholder
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

  @impl ChalkSync.Stateholder
  def recover(%Identity{} = identity, cursor) do
    case Postgrex.transaction(
           Database.connection(identity.episode),
           &RecoveryReader.transaction(&1, identity, cursor),
           timeout: @transaction_timeout_ms
         ) do
      {:ok, %Recovery{} = recovery} -> {:ok, recovery}
      {:ok, {:error, reason}} -> {:error, reason}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  @doc false
  def recover(%EpisodeKey{} = episode, cursor) do
    case Postgrex.transaction(
           Database.connection(episode),
           &RecoveryReader.transaction(&1, episode, cursor),
           timeout: @transaction_timeout_ms
         ) do
      {:ok, %Recovery{} = recovery} -> {:ok, recovery}
      {:ok, {:error, reason}} -> {:error, reason}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  @impl ChalkSync.Stateholder
  def recover_episode(%EpisodeKey{} = episode, cursor), do: recover(episode, cursor)

  @impl ChalkSync.Stateholder
  def recovery_page(%EpisodeKey{} = episode, after_revision, through_revision),
    do: RecoveryReader.page(episode, after_revision, through_revision)

  @doc false
  @spec durable_synchronous_commit?(term()) :: boolean()
  def durable_synchronous_commit?(setting), do: Transaction.durable_synchronous_commit?(setting)

  defp run_decision_transaction(identity, command) do
    Postgrex.transaction(
      Database.connection(identity.episode),
      &CommandDecision.transaction(&1, identity, command),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync command"
    )
  end

  defp run_lifecycle_transaction(episode, lifecycle_intent_id) do
    Postgrex.transaction(
      Database.connection(episode),
      &Lifecycle.transaction(&1, episode, lifecycle_intent_id),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync lifecycle intent"
    )
  end

  defp run_operation_transaction(identity, operation) do
    Postgrex.transaction(
      Database.connection(identity.episode),
      &ExternalOperationPlanner.accept_transaction(&1, identity, operation),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync external operation acceptance"
    )
  end

  defp run_internal_operation_transaction(episode, operation) do
    Postgrex.transaction(
      Database.connection(episode),
      &ExternalOperationPlanner.accept_internal_transaction(&1, episode, operation),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync internal operation acceptance"
    )
  end

  defp run_operation_finalization(episode, external_operation_id, outcome) do
    Postgrex.transaction(
      Database.connection(episode),
      &ExternalOperationFinalizer.finalize_transaction(
        &1,
        episode,
        external_operation_id,
        outcome
      ),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync external operation finalization"
    )
  end
end
