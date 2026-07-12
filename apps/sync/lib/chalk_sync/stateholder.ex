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
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
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

  @optional_callbacks load: 1, commit: 4, events_since: 2

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

  @spec load(String.t()) :: {:ok, Room.t()} | :not_found
  def load(room_id), do: impl().load(room_id)

  @spec commit(String.t(), non_neg_integer(), Room.event(), Room.t()) ::
          :ok | {:error, {:revision_conflict, non_neg_integer()}}
  def commit(room_id, expected_revision, event, state),
    do: impl().commit(room_id, expected_revision, event, state)

  @spec events_since(String.t(), non_neg_integer()) ::
          {:ok, [Room.event()]} | {:error, :cursor_unavailable}
  def events_since(room_id, cursor), do: impl().events_since(room_id, cursor)

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
