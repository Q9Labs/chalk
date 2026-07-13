defmodule ChalkSync.Stateholder do
  @moduledoc """
  Semantic durable-decision boundary for sync control state.

  A production adapter owns the complete command transaction. Callers cannot
  assemble a receipt, event, revision, and folded state through independent
  writes. Memory exists only for deterministic conformance and model tests.
  """

  alias ChalkSync.Rooms.Room
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.Telemetry

  @callback decide_command(Identity.t(), Command.t()) ::
              {:ok, Decision.t()} | {:retryable, atom()}
  @callback resolve_receipt(Identity.t(), Command.t()) ::
              {:ok, Decision.t()} | :not_found | {:retryable, atom()}
  @callback recover(Identity.t(), map() | nil) ::
              {:ok, Recovery.t()} | {:error, atom()} | {:retryable, atom()}
  @callback recover_session(SessionKey.t(), map() | nil) ::
              {:ok, Recovery.t()} | {:error, atom()} | {:retryable, atom()}
  @callback recovery_page(SessionKey.t(), non_neg_integer(), non_neg_integer()) ::
              {:ok, [map()]} | {:error, atom()} | {:retryable, atom()}
  @callback apply_lifecycle_intent(SessionKey.t(), String.t()) ::
              {:ok, LifecycleDecision.t()} | {:error, atom()} | {:retryable, atom()}
  @callback record_lifecycle_failure(SessionKey.t(), String.t(), atom()) ::
              :ok | {:retryable, atom()}
  @callback pending_lifecycle_intents(pos_integer()) ::
              {:ok, [{SessionKey.t(), String.t()}]} | {:retryable, atom()}
  @callback begin_operation(Identity.t(), Operation.t()) ::
              {:ok, OperationDecision.t()} | {:retryable, atom()}
  @callback begin_internal_operation(SessionKey.t(), Operation.t()) ::
              {:ok, OperationDecision.t()} | {:error, atom()} | {:retryable, atom()}
  @callback claim_operations(pos_integer()) ::
              {:ok, [{SessionKey.t(), ExternalOperation.t()}]} | {:retryable, atom()}
  @callback claim_local_operations(pos_integer()) ::
              {:ok, [{SessionKey.t(), ExternalOperation.t()}]} | {:retryable, atom()}
  @callback read_operation(SessionKey.t(), String.t()) ::
              {:ok, ExternalOperation.t()} | :not_found | {:retryable, atom()}
  @callback finalize_operation(SessionKey.t(), String.t(), tuple()) ::
              {:ok, OperationDecision.t()} | {:error, atom()} | {:retryable, atom()}
  @callback participant_authority(SessionKey.t(), String.t(), pos_integer() | nil) ::
              {:ok,
               %{
                 participant_session_id: String.t(),
                 generation: pos_integer(),
                 role: String.t(),
                 capabilities: [String.t()]
               }}
              | {:error, atom()}
              | {:retryable, atom()}
  @callback reserve_publication_grant(Identity.t(), String.t(), MediaPlane.source()) ::
              {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  @callback complete_publication_grant(SessionKey.t(), String.t(), MediaPlane.outcome()) ::
              {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  @callback begin_role_transition(Identity.t(), Command.t(), [MediaPlane.publication()]) ::
              {:ok, Decision.t()} | {:retryable, atom()}

  # Temporary v1 compatibility callbacks. They are removed with RoomServer in
  # the coordinator migration; production adapters do not implement them.
  @callback load(room_id :: String.t()) :: {:ok, Room.t()} | :not_found
  @callback commit(
              room_id :: String.t(),
              expected_revision :: non_neg_integer(),
              event :: Room.event(),
              state :: Room.t()
            ) :: :ok | {:error, {:revision_conflict, non_neg_integer()}}
  @callback events_since(room_id :: String.t(), cursor :: non_neg_integer()) ::
              {:ok, [Room.event()]} | {:error, :cursor_unavailable}

  @optional_callbacks load: 1,
                      commit: 4,
                      events_since: 2

  @spec impl() :: module()
  def impl, do: Application.fetch_env!(:chalk_sync, :stateholder)

  @spec decide_command(Identity.t(), Command.t()) ::
          {:ok, Decision.t()} | {:retryable, atom()}
  def decide_command(%Identity{} = identity, %Command{} = command) do
    started_at = System.monotonic_time(:microsecond)
    result = impl().decide_command(identity, command)

    Telemetry.execute(
      [:command, :decision],
      %{duration_us: elapsed_us(started_at), bytes: command.normalized_bytes},
      %{outcome: decision_outcome(result)}
    )

    result
  end

  @spec resolve_receipt(Identity.t(), Command.t()) ::
          {:ok, Decision.t()} | :not_found | {:retryable, atom()}
  def resolve_receipt(%Identity{} = identity, %Command{} = command),
    do: impl().resolve_receipt(identity, command)

  @spec recover(Identity.t(), map() | nil) ::
          {:ok, Recovery.t()} | {:error, atom()} | {:retryable, atom()}
  def recover(%Identity{} = identity, cursor) do
    timed_recovery(fn -> impl().recover(identity, cursor) end)
  end

  @spec recover_session(SessionKey.t(), map() | nil) ::
          {:ok, Recovery.t()} | {:error, atom()} | {:retryable, atom()}
  def recover_session(%SessionKey{} = session, cursor),
    do: timed_recovery(fn -> impl().recover_session(session, cursor) end)

  @spec recovery_page(SessionKey.t(), non_neg_integer(), non_neg_integer()) ::
          {:ok, [map()]} | {:error, atom()} | {:retryable, atom()}
  def recovery_page(%SessionKey{} = session, after_revision, through_revision)
      when is_integer(after_revision) and is_integer(through_revision) and
             after_revision >= 0 and through_revision >= after_revision do
    impl().recovery_page(session, after_revision, through_revision)
  end

  @spec apply_lifecycle_intent(SessionKey.t(), String.t()) ::
          {:ok, LifecycleDecision.t()} | {:error, atom()} | {:retryable, atom()}
  def apply_lifecycle_intent(%SessionKey{} = session, lifecycle_intent_id) do
    started_at = System.monotonic_time(:microsecond)
    result = impl().apply_lifecycle_intent(session, lifecycle_intent_id)

    Telemetry.execute(
      [:lifecycle, :decision],
      %{duration_us: elapsed_us(started_at)},
      %{outcome: lifecycle_outcome(result)}
    )

    result
  end

  @spec record_lifecycle_failure(SessionKey.t(), String.t(), atom()) ::
          :ok | {:retryable, atom()}
  def record_lifecycle_failure(%SessionKey{} = session, lifecycle_intent_id, reason)
      when is_binary(lifecycle_intent_id) and is_atom(reason),
      do: impl().record_lifecycle_failure(session, lifecycle_intent_id, reason)

  @spec pending_lifecycle_intents(pos_integer()) ::
          {:ok, [{SessionKey.t(), String.t()}]} | {:retryable, atom()}
  def pending_lifecycle_intents(limit) when is_integer(limit) and limit > 0,
    do: impl().pending_lifecycle_intents(limit)

  @spec begin_operation(Identity.t(), Operation.t()) ::
          {:ok, OperationDecision.t()} | {:retryable, atom()}
  def begin_operation(%Identity{} = identity, %Operation{} = operation),
    do: impl().begin_operation(identity, operation)

  @spec begin_internal_operation(SessionKey.t(), Operation.t()) ::
          {:ok, OperationDecision.t()} | {:error, atom()} | {:retryable, atom()}
  def begin_internal_operation(%SessionKey{} = session, %Operation{} = operation),
    do: impl().begin_internal_operation(session, operation)

  @spec claim_operations(pos_integer()) ::
          {:ok, [{SessionKey.t(), ExternalOperation.t()}]} | {:retryable, atom()}
  def claim_operations(limit) when is_integer(limit) and limit in 1..64,
    do: impl().claim_operations(limit)

  @spec claim_local_operations(pos_integer()) ::
          {:ok, [{SessionKey.t(), ExternalOperation.t()}]} | {:retryable, atom()}
  def claim_local_operations(limit) when is_integer(limit) and limit in 1..64,
    do: impl().claim_local_operations(limit)

  @spec read_operation(SessionKey.t(), String.t()) ::
          {:ok, ExternalOperation.t()} | :not_found | {:retryable, atom()}
  def read_operation(%SessionKey{} = session, external_operation_id)
      when is_binary(external_operation_id),
      do: impl().read_operation(session, external_operation_id)

  @spec finalize_operation(SessionKey.t(), String.t(), tuple()) ::
          {:ok, OperationDecision.t()} | {:error, atom()} | {:retryable, atom()}
  def finalize_operation(%SessionKey{} = session, external_operation_id, outcome)
      when is_binary(external_operation_id) and is_tuple(outcome),
      do: impl().finalize_operation(session, external_operation_id, outcome)

  @spec participant_authority(SessionKey.t(), String.t(), pos_integer() | nil) ::
          {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  def participant_authority(%SessionKey{} = session, participant_session_id, expected_generation)
      when is_binary(participant_session_id) and
             (is_nil(expected_generation) or
                (is_integer(expected_generation) and expected_generation > 0)),
      do: impl().participant_authority(session, participant_session_id, expected_generation)

  @spec reserve_publication_grant(Identity.t(), String.t(), MediaPlane.source()) ::
          {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  def reserve_publication_grant(%Identity{} = identity, operation_id, source)
      when is_binary(operation_id),
      do: impl().reserve_publication_grant(identity, operation_id, source)

  @spec complete_publication_grant(SessionKey.t(), String.t(), MediaPlane.outcome()) ::
          {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  def complete_publication_grant(%SessionKey{} = session, reservation_id, outcome)
      when is_binary(reservation_id),
      do: impl().complete_publication_grant(session, reservation_id, outcome)

  @spec begin_role_transition(Identity.t(), Command.t(), [MediaPlane.publication()]) ::
          {:ok, Decision.t()} | {:retryable, atom()}
  def begin_role_transition(%Identity{} = identity, %Command{} = command, publications)
      when is_list(publications),
      do: impl().begin_role_transition(identity, command, publications)

  @spec load(String.t()) :: {:ok, Room.t()} | :not_found
  def load(room_id, observability \\ nil) do
    result = impl().load(room_id)

    ChalkSync.Observability.linked_phase(observability, "sync.stateholder.load", %{
      result: load_result(result)
    })

    result
  end

  @spec commit(String.t(), non_neg_integer(), Room.event(), Room.t()) ::
          :ok | {:error, {:revision_conflict, non_neg_integer()}}
  def commit(room_id, expected_revision, event, state, observability \\ nil) do
    result = impl().commit(room_id, expected_revision, event, state)

    ChalkSync.Observability.linked_phase(observability, "sync.stateholder.commit", %{
      result: commit_result(result)
    })

    result
  end

  @spec events_since(String.t(), non_neg_integer()) ::
          {:ok, [Room.event()]} | {:error, :cursor_unavailable}
  def events_since(room_id, cursor, observability \\ nil) do
    result = impl().events_since(room_id, cursor)

    ChalkSync.Observability.linked_phase(observability, "sync.stateholder.replay", %{
      result: replay_result(result)
    })

    result
  end

  defp load_result({:ok, _room}), do: "found"
  defp load_result(:not_found), do: "not_found"
  defp commit_result(:ok), do: "committed"
  defp commit_result({:error, {:revision_conflict, _current}}), do: "revision_conflict"
  defp replay_result({:ok, _events}), do: "available"
  defp replay_result({:error, :cursor_unavailable}), do: "cursor_unavailable"

  defp timed_recovery(operation) do
    started_at = System.monotonic_time(:microsecond)
    result = operation.()

    Telemetry.execute(
      [:recovery, :read],
      %{duration_us: elapsed_us(started_at)},
      %{outcome: recovery_outcome(result)}
    )

    result
  end

  defp decision_outcome({:ok, %{result: result}}), do: result
  defp decision_outcome({:retryable, _reason}), do: :retryable
  defp decision_outcome(_result), do: :error

  defp lifecycle_outcome({:ok, %{result: result}}), do: result
  defp lifecycle_outcome({:retryable, _reason}), do: :retryable
  defp lifecycle_outcome(_result), do: :error

  defp recovery_outcome({:ok, %{mode: mode}}), do: mode
  defp recovery_outcome({:retryable, _reason}), do: :retryable
  defp recovery_outcome(_result), do: :error

  defp elapsed_us(started_at), do: max(System.monotonic_time(:microsecond) - started_at, 0)
end
