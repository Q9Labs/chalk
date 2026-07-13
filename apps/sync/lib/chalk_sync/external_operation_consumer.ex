defmodule ChalkSync.ExternalOperationConsumer do
  @moduledoc """
  Bounded executor for durable provider-neutral external operations.

  PostgreSQL claims are the multi-node exclusion barrier. Adapter calls happen
  after the claim transaction and retain the stable external operation id.
  Ambiguous and retryable outcomes remain pending for the durable claim
  schedule; only confirmed or terminal outcomes are finalized.
  """

  use GenServer

  require Logger

  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.Telemetry

  @default_page_size 32
  @default_max_backoff_ms 5_000
  @default_adapter_timeout_ms 5_000
  @max_attempts 100
  @local_operations [
    :admit_participant,
    :deny_admission,
    :admission_request_expired,
    :tenant_transfer_host,
    :tenant_set_deadline
  ]
  @end_session_operations [
    :end_session,
    :tenant_end_session,
    :maximum_duration_expired
  ]

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__), do: GenServer.call(server, :health)

  @impl GenServer
  def init(options) do
    poll_interval_ms = Keyword.fetch!(options, :poll_interval_ms)

    state = %{
      page_size: Keyword.get(options, :page_size, @default_page_size),
      adapter_timeout_ms: Keyword.get(options, :adapter_timeout_ms, @default_adapter_timeout_ms),
      poll_interval_ms: poll_interval_ms,
      max_backoff_ms: Keyword.get(options, :max_backoff_ms, @default_max_backoff_ms),
      media_plane: Keyword.get(options, :media_plane),
      recording_plane: Keyword.get(options, :recording_plane),
      last_success_at_ms: nil,
      consecutive_failures: 0,
      confirmed_count: 0,
      terminal_failure_count: 0,
      retained_pending_count: 0
    }

    send(self(), :poll)
    {:ok, state}
  end

  @impl GenServer
  def handle_call(:health, _from, state), do: {:reply, state, state}

  @impl GenServer
  def handle_info(:poll, state) do
    {delay, state} = poll(state)
    Process.send_after(self(), :poll, delay)
    {:noreply, state}
  end

  @doc false
  @spec execute_operation(
          SessionKey.t(),
          ExternalOperation.t(),
          {module(), term()} | nil,
          {module(), term()} | nil,
          (SessionKey.t(), String.t(), tuple() -> term()),
          pos_integer()
        ) :: :confirmed | :terminal_failure | :pending | :finalization_failure
  def execute_operation(
        session,
        operation,
        media_plane,
        recording_plane,
        finalize,
        adapter_timeout_ms \\ @default_adapter_timeout_ms
      )
      when is_function(finalize, 3) and is_integer(adapter_timeout_ms) and
             adapter_timeout_ms > 0 do
    case dispatch(session, operation, media_plane, recording_plane, adapter_timeout_ms) do
      {:confirmed, authority} ->
        finalize_confirmed(session, operation, authority, finalize)

      {:terminal_failure, reason} ->
        finalize_terminal_failure(session, operation, reason, finalize)

      :pending ->
        if operation.attempt_count >= @max_attempts,
          do: finalize_terminal_failure(session, operation, :retry_exhausted, finalize),
          else: :pending
    end
  end

  defp poll(state) do
    case Stateholder.claim_operations(state.page_size) do
      {:ok, operations} ->
        {counts, failures} = execute_page(operations, state)

        Telemetry.execute(
          [:external_operation, :poll],
          %{count: length(operations)},
          %{outcome: if(failures == 0, do: :success, else: :operation_failure)}
        )

        consecutive_failures = if failures == 0, do: 0, else: state.consecutive_failures + 1

        next =
          state
          |> Map.put(:last_success_at_ms, System.monotonic_time(:millisecond))
          |> Map.put(:consecutive_failures, consecutive_failures)
          |> increment_counts(counts)

        delay =
          if length(operations) == state.page_size and failures == 0,
            do: 0,
            else: backoff(next)

        {delay, next}

      {:retryable, reason} ->
        Telemetry.execute([:external_operation, :poll], %{}, %{outcome: :failure})
        Logger.warning("sync external operation discovery unavailable: reason=#{reason}")
        next = %{state | consecutive_failures: state.consecutive_failures + 1}
        {backoff(next), next}
    end
  end

  defp execute_page(operations, state) do
    Enum.reduce(operations, {%{confirmed: 0, terminal_failure: 0, pending: 0}, 0}, fn
      {session, operation}, {counts, failures} ->
        result =
          execute_operation(
            session,
            operation,
            state.media_plane,
            state.recording_plane,
            &Stateholder.finalize_operation/3,
            state.adapter_timeout_ms
          )

        report_result(operation.name, result)

        case result do
          :confirmed ->
            {%{counts | confirmed: counts.confirmed + 1}, failures}

          :terminal_failure ->
            {%{counts | terminal_failure: counts.terminal_failure + 1}, failures}

          :pending ->
            {%{counts | pending: counts.pending + 1}, failures}

          :finalization_failure ->
            {counts, failures + 1}
        end
    end)
  end

  defp dispatch(_session, %{name: name}, _media_plane, _recording_plane, _timeout_ms)
       when name in @local_operations,
       do: {:confirmed, :local}

  defp dispatch(session, %{name: name} = operation, media_plane, recording_plane, timeout_ms)
       when name in @end_session_operations do
    invoke_end_cleanup(media_plane, recording_plane, session, operation, timeout_ms)
  end

  defp dispatch(session, %{name: name} = operation, media_plane, _recording_plane, timeout_ms)
       when name in [
              :mute_participant,
              :stop_participant_camera,
              :stop_participant_screen_share,
              :remove_participant,
              :participant_leave,
              :role_transition_source_stop
            ] do
    invoke_media_plane(media_plane, session, operation, timeout_ms)
  end

  defp dispatch(session, %{name: name} = operation, _media_plane, recording_plane, timeout_ms)
       when name in [:start_recording, :stop_recording] do
    invoke_recording_plane(recording_plane, session, operation, timeout_ms)
  end

  defp invoke_media_plane(nil, _session, _operation, _timeout_ms), do: :pending

  defp invoke_media_plane({module, adapter}, session, operation, timeout_ms) do
    arguments = media_arguments(adapter, session, operation)
    invoke_adapter(module, arguments, :provider, timeout_ms)
  end

  defp media_arguments(adapter, session, %{name: :mute_participant} = operation),
    do: revoke_arguments(adapter, session, operation, :microphone)

  defp media_arguments(adapter, session, %{name: :stop_participant_camera} = operation),
    do: revoke_arguments(adapter, session, operation, :camera)

  defp media_arguments(adapter, session, %{name: :stop_participant_screen_share} = operation),
    do: revoke_arguments(adapter, session, operation, :screen)

  defp media_arguments(adapter, session, %{name: :role_transition_source_stop} = operation),
    do: revoke_arguments(adapter, session, operation, operation.source)

  defp media_arguments(adapter, session, %{name: name} = operation)
       when name in [:remove_participant, :participant_leave] do
    {:remove_participant,
     [adapter, operation.external_operation_id, session, operation.target_participant_session_id]}
  end

  defp media_arguments(adapter, session, %{name: name} = operation)
       when name in @end_session_operations,
       do: {:end_session, [adapter, operation.external_operation_id, session]}

  defp revoke_arguments(adapter, session, operation, source) do
    {:revoke_publication,
     [
       adapter,
       operation.external_operation_id,
       session,
       operation.target_participant_session_id,
       source
     ]}
  end

  defp invoke_recording_plane(nil, _session, _operation, _timeout_ms), do: :pending

  defp invoke_recording_plane({module, adapter}, session, operation, timeout_ms) do
    arguments =
      {operation.name,
       [adapter, operation.external_operation_id, session, operation.recording_id]}

    invoke_adapter(module, arguments, :recording, timeout_ms)
  end

  defp invoke_end_cleanup(
         media_plane,
         _recording_plane,
         session,
         %{recording_id: nil} = operation,
         timeout_ms
       ),
       do: invoke_media_plane(media_plane, session, operation, timeout_ms)

  defp invoke_end_cleanup(media_plane, recording_plane, session, operation, timeout_ms) do
    calls = [
      end_media_call(media_plane, session, operation),
      end_recording_call(recording_plane, session, operation)
    ]

    results =
      calls
      |> Enum.reject(&is_nil/1)
      |> invoke_adapter_calls(timeout_ms)

    missing_count = Enum.count(calls, &is_nil/1)
    combine_end_cleanup(List.duplicate(:pending, missing_count) ++ results)
  end

  defp end_media_call(nil, _session, _operation), do: nil

  defp end_media_call({module, adapter}, session, operation) do
    {function, arguments} = media_arguments(adapter, session, operation)
    {module, function, arguments, :provider}
  end

  defp end_recording_call(nil, _session, _operation), do: nil

  defp end_recording_call({module, adapter}, session, operation) do
    {module, :stop_recording,
     [adapter, operation.external_operation_id, session, operation.recording_id], :recording}
  end

  defp combine_end_cleanup(results) do
    case Enum.find(results, &match?({:terminal_failure, _reason}, &1)) do
      {:terminal_failure, reason} ->
        {:terminal_failure, reason}

      nil ->
        if Enum.all?(results, &match?({:confirmed, _authority}, &1)),
          do: {:confirmed, :provider},
          else: :pending
    end
  end

  defp invoke_adapter(module, {function, arguments}, authority, timeout_ms) do
    [{module, function, arguments, authority}]
    |> invoke_adapter_calls(timeout_ms)
    |> hd()
  end

  defp invoke_adapter_calls(calls, timeout_ms) do
    tasks =
      Enum.map(calls, fn {module, function, arguments, authority} ->
        task = Task.async(fn -> safe_adapter_call(module, function, arguments) end)
        {module, authority, task}
      end)

    yielded =
      tasks
      |> Enum.map(fn {_module, _authority, task} -> task end)
      |> Task.yield_many(timeout_ms)

    Enum.zip_with(tasks, yielded, fn
      {module, authority, task}, {task, result} ->
        adapter_task_result(module, authority, task, result)
    end)
  end

  defp adapter_task_result(_module, authority, _task, {:ok, {:ok, outcome}}),
    do: adapter_outcome(outcome, authority)

  defp adapter_task_result(module, _authority, _task, {:ok, {:error, failure}}) do
    Logger.warning(
      "sync external operation adapter failed: adapter=#{inspect(module)} failure=#{failure}"
    )

    :pending
  end

  defp adapter_task_result(module, _authority, task, nil) do
    Task.shutdown(task, :brutal_kill)
    Logger.warning("sync external operation adapter timed out: adapter=#{inspect(module)}")
    :pending
  end

  defp safe_adapter_call(module, function, arguments) do
    {:ok, apply(module, function, arguments)}
  rescue
    _exception -> {:error, :raised}
  catch
    :exit, _reason -> {:error, :exited}
  end

  defp adapter_outcome(outcome, authority) when outcome in [:confirmed, :satisfied],
    do: {:confirmed, authority}

  defp adapter_outcome({:terminal_failure, reason}, _authority) when is_atom(reason),
    do: {:terminal_failure, reason}

  defp adapter_outcome(_outcome, _authority), do: :pending

  defp finalize_confirmed(session, operation, authority, finalize) do
    case finalize.(session, operation.external_operation_id, {:confirmed, authority}) do
      {:ok, _decision} -> :confirmed
      result -> finalization_failure(operation.name, result)
    end
  end

  defp finalize_terminal_failure(session, operation, reason, finalize) do
    case finalize.(session, operation.external_operation_id, {:failed, reason}) do
      {:ok, _decision} -> :terminal_failure
      result -> finalization_failure(operation.name, result)
    end
  end

  defp finalization_failure(operation, result) do
    Logger.warning(
      "sync external operation finalization unavailable: operation=#{operation} " <>
        "result=#{inspect(result)}"
    )

    :finalization_failure
  end

  defp report_result(operation, result) do
    Telemetry.execute(
      [:external_operation, :execution],
      %{count: 1},
      %{operation: operation, outcome: result}
    )
  end

  defp increment_counts(state, counts) do
    %{
      state
      | confirmed_count: state.confirmed_count + counts.confirmed,
        terminal_failure_count: state.terminal_failure_count + counts.terminal_failure,
        retained_pending_count: state.retained_pending_count + counts.pending
    }
  end

  defp backoff(state) do
    backoff_delay(
      state.poll_interval_ms,
      state.max_backoff_ms,
      state.consecutive_failures
    )
  end

  @doc false
  @spec backoff_delay(pos_integer(), pos_integer(), non_neg_integer()) :: pos_integer()
  def backoff_delay(poll_interval_ms, _max_backoff_ms, 0), do: poll_interval_ms

  def backoff_delay(poll_interval_ms, max_backoff_ms, consecutive_failures) do
    multiplier = Integer.pow(2, min(consecutive_failures - 1, 6))
    min(poll_interval_ms * multiplier, max_backoff_ms)
  end
end
