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
  alias ChalkSync.Stateholder.Postgres.CommandDecision
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.Stateholder.Postgres.JoinSeats
  alias ChalkSync.Stateholder.Postgres.Lifecycle
  alias ChalkSync.Stateholder.Postgres.Operations
  alias ChalkSync.Stateholder.Postgres.Media
  alias ChalkSync.Stateholder.Postgres.Presence
  alias ChalkSync.Stateholder.Postgres.RecoveryReader
  alias ChalkSync.Stateholder.Postgres.RoleTransitionPlanner
  alias ChalkSync.Stateholder.Postgres.ScreenLeases
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.Stateholder.Postgres.WebhookObservation
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.UUID

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
  def apply_lifecycle_intent(%EpisodeKey{} = episode, lifecycle_intent_id),
    do: apply_lifecycle(episode, lifecycle_intent_id, nil)

  @impl ChalkSync.Stateholder
  def confirm_admission(%Identity{} = identity),
    do: apply_lifecycle(identity.episode, identity.admission_lifecycle_intent_id, identity)

  @impl ChalkSync.Stateholder
  def admit_entry(%Identity{} = identity, requested) do
    case Transaction.run(identity.episode, &JoinSeats.Admit.admit_entry(&1, identity, requested)) do
      {:ok, admitted} -> {:ok, admitted}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  end

  @impl ChalkSync.Stateholder
  def renew_presence(%Identity{} = identity) do
    Database.guard(
      fn ->
        case Transaction.run(identity.episode, &Presence.transaction(&1, identity)) do
          {:ok, :ok} -> :ok
          {:error, {:error, reason}} -> {:error, reason}
          {:error, _reason} -> {:retryable, :dependency_unavailable}
        end
      end,
      {:retryable, :dependency_unavailable}
    )
  end

  @impl ChalkSync.Stateholder
  def prepare_entry_leave(episode, operation_id) do
    Database.guard(
      fn ->
        case Transaction.run(episode, &JoinSeats.prepare_leave(&1, episode, operation_id)) do
          {:ok, disposition} -> disposition
          {:error, _reason} -> :pending
        end
      end,
      :pending
    )
  end

  defp apply_lifecycle(episode, lifecycle_intent_id, identity)
       when is_binary(lifecycle_intent_id) do
    case UUID.dump(lifecycle_intent_id) do
      {:ok, _uuid} ->
        case run_lifecycle_transaction(episode, lifecycle_intent_id, identity) do
          {:ok, %LifecycleDecision{} = decision} ->
            FaultHooks.lifecycle(:after_commit_before_reply, episode, lifecycle_intent_id)
            WebhookObservation.lifecycle(episode, lifecycle_intent_id, decision)
            {:ok, decision}

          {:error, {:retryable, reason}} ->
            {:retryable, reason}

          {:error, {:error, reason}} ->
            {:error, reason}

          {:error, _reason} ->
            Lifecycle.resolve_uncertain(episode, lifecycle_intent_id, identity)
        end

      :error ->
        {:error, :invalid_lifecycle_intent_id}
    end
  rescue
    exception ->
      Logger.error("sync lifecycle transaction became uncertain: #{Exception.message(exception)}")
      Lifecycle.resolve_uncertain(episode, lifecycle_intent_id, identity)
  catch
    :exit, reason ->
      Logger.error("sync lifecycle transaction exited before resolution: #{inspect(reason)}")
      Lifecycle.resolve_uncertain(episode, lifecycle_intent_id, identity)
  end

  @impl ChalkSync.Stateholder
  def record_lifecycle_failure(%EpisodeKey{} = episode, lifecycle_intent_id, reason)
      when is_binary(lifecycle_intent_id) and is_atom(reason),
      do: Lifecycle.record_lifecycle_failure(episode, lifecycle_intent_id, reason)

  @impl ChalkSync.Stateholder
  def pending_lifecycle_intents(limit) when is_integer(limit) and limit in 1..64,
    do: Lifecycle.pending_lifecycle_intents(limit)

  @impl ChalkSync.Stateholder
  def begin_role_transition(%Identity{} = identity, %Command{} = command, publications)
      when command.name in [:assign_roles] and is_list(publications) do
    Database.guard(
      fn ->
        case Transaction.run(
               identity.episode,
               &RoleTransitionPlanner.transaction(&1, identity, command, publications),
               commit_comment: "chalk sync role transition"
             ) do
          {:ok, decision} -> {:ok, decision}
          {:error, {:retryable, reason}} -> {:retryable, reason}
          {:error, _reason} -> CommandDecision.resolve_uncertain(identity, command)
        end
      end,
      CommandDecision.resolve_uncertain(identity, command)
    )
  end

  def begin_role_transition(%Identity{} = identity, %Command{} = command, _publications),
    do: decide_command(identity, command)

  @impl ChalkSync.Stateholder
  def recover(%Identity{} = identity, cursor),
    do: read_recovery(identity.episode, identity, cursor)

  @doc false
  def recover(%EpisodeKey{} = episode, cursor), do: read_recovery(episode, episode, cursor)

  defp read_recovery(episode, subject, cursor) do
    Database.guard(
      fn ->
        case Transaction.run(episode, &RecoveryReader.transaction(&1, subject, cursor)) do
          {:ok, %Recovery{} = recovery} -> {:ok, recovery}
          {:ok, {:error, reason}} -> {:error, reason}
          {:error, {:error, reason}} -> {:error, reason}
          {:error, _reason} -> {:retryable, :dependency_unavailable}
        end
      end,
      {:retryable, :dependency_unavailable}
    )
  end

  @impl ChalkSync.Stateholder
  def recover_episode(%EpisodeKey{} = episode, cursor), do: recover(episode, cursor)

  @impl ChalkSync.Stateholder
  def recovery_page(%EpisodeKey{} = episode, after_revision, through_revision),
    do: RecoveryReader.page(episode, after_revision, through_revision)

  @impl ChalkSync.Stateholder
  defdelegate begin_operation(a, b), to: Operations

  @impl ChalkSync.Stateholder
  defdelegate begin_internal_operation(a, b), to: Operations

  @impl ChalkSync.Stateholder
  defdelegate claim_operations(a), to: Operations

  @impl ChalkSync.Stateholder
  defdelegate claim_local_operations(a), to: Operations

  @impl ChalkSync.Stateholder
  defdelegate claim_provider_operations(a), to: Operations

  @impl ChalkSync.Stateholder
  defdelegate read_operation(a, b), to: Operations

  @impl ChalkSync.Stateholder
  defdelegate finalize_operation(a, b, c), to: Operations

  @impl ChalkSync.Stateholder
  defdelegate participant_authority(a, b, c), to: Media

  @impl ChalkSync.Stateholder
  defdelegate participant_devices(a), to: Media

  @impl ChalkSync.Stateholder
  defdelegate media_pauses(a), to: Media

  @impl ChalkSync.Stateholder
  defdelegate media_stops(a), to: Media

  @impl ChalkSync.Stateholder
  defdelegate acquire_screen_lease(a, b, c, d), to: ScreenLeases

  @impl ChalkSync.Stateholder
  defdelegate renew_screen_lease(a, b, c), to: ScreenLeases

  @impl ChalkSync.Stateholder
  defdelegate release_screen_lease(a, b), to: ScreenLeases

  @impl ChalkSync.Stateholder
  defdelegate set_media_pause(a, b, c), to: Media

  @impl ChalkSync.Stateholder
  defdelegate reserve_publication_grant(a, b, c), to: Media

  @impl ChalkSync.Stateholder
  defdelegate complete_publication_grant(a, b, c), to: Media

  @doc false
  @spec durable_synchronous_commit?(term()) :: boolean()
  def durable_synchronous_commit?(setting), do: Transaction.durable_synchronous_commit?(setting)

  defp run_decision_transaction(identity, command) do
    Transaction.run(identity.episode, &CommandDecision.transaction(&1, identity, command),
      commit_comment: "chalk sync command"
    )
  end

  defp run_lifecycle_transaction(episode, lifecycle_intent_id, identity) do
    Transaction.run(episode, &Lifecycle.transaction(&1, episode, lifecycle_intent_id, identity),
      commit_comment: "chalk sync lifecycle intent"
    )
  end
end
