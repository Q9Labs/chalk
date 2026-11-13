defmodule ChalkSync.Stateholder do
  @moduledoc """
  Semantic durable-decision boundary for sync control state.

  The adapter owns the complete command transaction. Callers cannot assemble a
  receipt, event, revision, and folded state through independent writes.
  `Stateholder.Postgres` is the only adapter; tests substitute stubs through the
  `:stateholder` setting.
  """

  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Telemetry

  @callback decide_command(Identity.t(), Command.t()) ::
              {:ok, Decision.t()} | {:retryable, atom()}
  @callback resolve_receipt(Identity.t(), Command.t()) ::
              {:ok, Decision.t()} | :not_found | {:retryable, atom()}
  @callback recover(Identity.t(), map() | nil) ::
              {:ok, Recovery.t()} | {:error, atom()} | {:retryable, atom()}
  @callback recover_episode(EpisodeKey.t(), map() | nil) ::
              {:ok, Recovery.t()} | {:error, atom()} | {:retryable, atom()}
  @callback recovery_page(EpisodeKey.t(), non_neg_integer(), non_neg_integer()) ::
              {:ok, [map()]} | {:error, atom()} | {:retryable, atom()}
  @callback apply_lifecycle_intent(EpisodeKey.t(), String.t()) ::
              {:ok, LifecycleDecision.t()} | {:error, atom()} | {:retryable, atom()}
  @callback confirm_admission(Identity.t()) ::
              {:ok, LifecycleDecision.t()} | {:error, atom()} | {:retryable, atom()}

  @callback admit_entry(
              Identity.t(),
              :new | :legacy | pos_integer() | {:socket, :new | :legacy | pos_integer()}
            ) ::
              {:ok, Identity.t()} | {:error, atom()} | {:retryable, atom()}
  @callback renew_presence(Identity.t()) :: :ok | {:error, atom()} | {:retryable, atom()}
  @callback prepare_entry_leave(EpisodeKey.t(), String.t()) :: :ready | :pending | :superseded
  @callback record_lifecycle_failure(EpisodeKey.t(), String.t(), atom()) ::
              :ok | {:retryable, atom()}
  @callback pending_lifecycle_intents(pos_integer()) ::
              {:ok, [{EpisodeKey.t(), String.t()}]} | {:retryable, atom()}
  @callback begin_operation(Identity.t(), Operation.t()) ::
              {:ok, OperationDecision.t()} | {:retryable, atom()}
  @callback begin_internal_operation(EpisodeKey.t(), Operation.t()) ::
              {:ok, OperationDecision.t()} | {:error, atom()} | {:retryable, atom()}
  @callback claim_operations(pos_integer()) ::
              {:ok, [{EpisodeKey.t(), ExternalOperation.t()}]} | {:retryable, atom()}
  @callback claim_local_operations(pos_integer()) ::
              {:ok, [{EpisodeKey.t(), ExternalOperation.t()}]} | {:retryable, atom()}
  @callback claim_provider_operations(pos_integer()) ::
              {:ok, [{EpisodeKey.t(), ExternalOperation.t()}]} | {:retryable, atom()}
  @callback read_operation(EpisodeKey.t(), String.t()) ::
              {:ok, ExternalOperation.t()} | :not_found | {:retryable, atom()}
  @callback finalize_operation(EpisodeKey.t(), String.t(), tuple()) ::
              {:ok, OperationDecision.t()} | {:error, atom()} | {:retryable, atom()}
  @callback participant_authority(EpisodeKey.t(), String.t(), pos_integer() | nil) ::
              {:ok,
               %{
                 participant_id: String.t(),
                 generation: pos_integer(),
                 role: String.t(),
                 capabilities: [String.t()]
               }}
              | {:error, atom()}
              | {:retryable, atom()}
  @callback reserve_publication_grant(Identity.t(), String.t(), MediaPlane.source()) ::
              {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  @callback complete_publication_grant(EpisodeKey.t(), String.t(), MediaPlane.outcome()) ::
              {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  @callback participant_devices(EpisodeKey.t()) :: {:ok, [map()]} | {:retryable, atom()}
  @callback media_pauses(EpisodeKey.t()) ::
              {:ok, %{{String.t(), String.t()} => String.t()}} | {:retryable, atom()}
  @callback media_stops(EpisodeKey.t()) ::
              {:ok, %{{String.t(), String.t()} => pos_integer()}} | {:retryable, atom()}
  @callback set_media_pause(Identity.t(), :microphone | :camera | :screen, String.t() | nil) ::
              :ok | {:error, atom()} | {:retryable, atom()}
  @callback acquire_screen_lease(EpisodeKey.t(), String.t(), pos_integer(), keyword()) ::
              {:ok, map()} | {:error, atom()}
  @callback renew_screen_lease(EpisodeKey.t(), map(), keyword()) ::
              {:ok, map()} | {:error, atom()}
  @callback release_screen_lease(EpisodeKey.t(), map()) :: :ok | {:error, atom()}
  @callback begin_role_transition(Identity.t(), Command.t(), [MediaPlane.publication()]) ::
              {:ok, Decision.t()} | {:retryable, atom()}

  @spec impl() :: module()
  def impl, do: Application.fetch_env!(:chalk_sync, :stateholder)

  def decide_command(%Identity{} = identity, %Command{} = command) do
    started_at = System.monotonic_time(:microsecond)
    result = impl().decide_command(identity, command)

    Telemetry.execute(
      [:command, :decision],
      %{duration_us: elapsed_us(started_at), bytes: command.normalized_bytes},
      %{outcome: outcome(result)}
    )

    result
  end

  def resolve_receipt(%Identity{} = identity, %Command{} = command),
    do: impl().resolve_receipt(identity, command)

  def recover(%Identity{} = identity, cursor) do
    timed_recovery(fn -> impl().recover(identity, cursor) end)
  end

  def recover_episode(%EpisodeKey{} = episode, cursor),
    do: timed_recovery(fn -> impl().recover_episode(episode, cursor) end)

  def recovery_page(%EpisodeKey{} = episode, after_revision, through_revision)
      when is_integer(after_revision) and is_integer(through_revision) and
             after_revision >= 0 and through_revision >= after_revision do
    impl().recovery_page(episode, after_revision, through_revision)
  end

  def participant_devices(%EpisodeKey{} = episode), do: impl().participant_devices(episode)

  def acquire_screen_lease(%EpisodeKey{} = episode, participant_id, generation, options),
    do: impl().acquire_screen_lease(episode, participant_id, generation, options)

  def renew_screen_lease(%EpisodeKey{} = episode, lease, options),
    do: impl().renew_screen_lease(episode, lease, options)

  def release_screen_lease(%EpisodeKey{} = episode, lease),
    do: impl().release_screen_lease(episode, lease)

  def media_pauses(%EpisodeKey{} = episode), do: impl().media_pauses(episode)

  @doc "The latest host stop for each participant and source, as `{participant_id, source} => event revision`."
  def media_stops(%EpisodeKey{} = episode), do: impl().media_stops(episode)

  def set_media_pause(%Identity{} = identity, source, publication_id)
      when source in [:microphone, :camera, :screen] and
             (is_nil(publication_id) or is_binary(publication_id)),
      do: impl().set_media_pause(identity, source, publication_id)

  def apply_lifecycle_intent(%EpisodeKey{} = episode, lifecycle_intent_id) do
    started_at = System.monotonic_time(:microsecond)
    result = impl().apply_lifecycle_intent(episode, lifecycle_intent_id)

    Telemetry.execute(
      [:lifecycle, :decision],
      %{duration_us: elapsed_us(started_at)},
      %{outcome: outcome(result)}
    )

    result
  end

  def confirm_admission(%Identity{} = identity) do
    started_at = System.monotonic_time(:microsecond)
    result = impl().confirm_admission(identity)

    Telemetry.execute(
      [:lifecycle, :decision],
      %{duration_us: elapsed_us(started_at)},
      %{outcome: outcome(result)}
    )

    result
  end

  def admit_entry(%Identity{}, :invalid), do: {:error, :invalid_admission_intent}
  def admit_entry(%Identity{} = identity, requested), do: impl().admit_entry(identity, requested)

  def renew_presence(%Identity{} = identity), do: impl().renew_presence(identity)

  def admit_socket_entry(%Identity{}, :invalid), do: {:error, :invalid_admission_intent}

  def admit_socket_entry(%Identity{} = identity, requested),
    do: impl().admit_entry(identity, {:socket, requested})

  def prepare_entry_leave(%EpisodeKey{} = episode, operation_id),
    do: impl().prepare_entry_leave(episode, operation_id)

  def record_lifecycle_failure(%EpisodeKey{} = episode, lifecycle_intent_id, reason)
      when is_binary(lifecycle_intent_id) and is_atom(reason),
      do: impl().record_lifecycle_failure(episode, lifecycle_intent_id, reason)

  def pending_lifecycle_intents(limit) when is_integer(limit) and limit > 0,
    do: impl().pending_lifecycle_intents(limit)

  def begin_operation(%Identity{} = identity, %Operation{} = operation),
    do: impl().begin_operation(identity, operation)

  def begin_internal_operation(%EpisodeKey{} = episode, %Operation{} = operation),
    do: impl().begin_internal_operation(episode, operation)

  def claim_operations(limit) when is_integer(limit) and limit in 1..64,
    do: impl().claim_operations(limit)

  def claim_local_operations(limit) when is_integer(limit) and limit in 1..64,
    do: impl().claim_local_operations(limit)

  def claim_provider_operations(limit) when is_integer(limit) and limit in 1..64,
    do: impl().claim_provider_operations(limit)

  def read_operation(%EpisodeKey{} = episode, external_operation_id)
      when is_binary(external_operation_id),
      do: impl().read_operation(episode, external_operation_id)

  def finalize_operation(%EpisodeKey{} = episode, external_operation_id, outcome)
      when is_binary(external_operation_id) and is_tuple(outcome),
      do: impl().finalize_operation(episode, external_operation_id, outcome)

  def participant_authority(%EpisodeKey{} = episode, participant_id, expected_generation)
      when is_binary(participant_id) and
             (is_nil(expected_generation) or
                (is_integer(expected_generation) and expected_generation > 0)),
      do: impl().participant_authority(episode, participant_id, expected_generation)

  def reserve_publication_grant(%Identity{} = identity, operation_id, source)
      when is_binary(operation_id),
      do: impl().reserve_publication_grant(identity, operation_id, source)

  def complete_publication_grant(%EpisodeKey{} = episode, reservation_id, outcome)
      when is_binary(reservation_id),
      do: impl().complete_publication_grant(episode, reservation_id, outcome)

  def begin_role_transition(%Identity{} = identity, %Command{} = command, publications)
      when is_list(publications),
      do: impl().begin_role_transition(identity, command, publications)

  defp timed_recovery(operation) do
    started_at = System.monotonic_time(:microsecond)
    result = operation.()

    Telemetry.execute(
      [:recovery, :read],
      %{duration_us: elapsed_us(started_at)},
      %{outcome: outcome(result)}
    )

    result
  end

  defp outcome({:ok, %{result: result}}), do: result
  defp outcome({:ok, %{mode: mode}}), do: mode
  defp outcome({:retryable, _reason}), do: :retryable
  defp outcome(_result), do: :error

  defp elapsed_us(started_at), do: max(System.monotonic_time(:microsecond) - started_at, 0)
end
