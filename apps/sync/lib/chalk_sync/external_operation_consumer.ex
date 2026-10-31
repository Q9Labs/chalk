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

  alias ChalkSync.Observability
  alias ChalkSync.ProviderBridge.MediaPlane, as: ProviderBridgeMediaPlane
  alias ChalkSync.ProviderBridge.RecordingPlane, as: ProviderBridgeRecordingPlane
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Telemetry

  @max_concurrency 8
  @default_page_size 32
  @default_max_backoff_ms 5_000
  @default_adapter_timeout_ms 5_000
  @health_timeout_ms 500
  @worker_completion_grace_ms 5_000
  @max_attempts 100
  @local_operations [
    :admit_participant,
    :participant_leave,
    :deny_admission,
    :admission_request_expired,
    :tenant_set_deadline,
    :recording_capture_ready,
    :recording_capture_stopped,
    :recording_capture_failed
  ]
  @end_episode_operations [
    :end_episode,
    :tenant_end_episode,
    :maximum_duration_expired
  ]

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__), do: GenServer.call(server, :health, @health_timeout_ms)

  @impl GenServer
  def init(options) do
    poll_interval_ms = Keyword.fetch!(options, :poll_interval_ms)

    state = %{
      page_size: Keyword.get(options, :page_size, @default_page_size),
      adapter_timeout_ms: Keyword.get(options, :adapter_timeout_ms, @default_adapter_timeout_ms),
      poll_interval_ms: poll_interval_ms,
      max_backoff_ms: Keyword.get(options, :max_backoff_ms, @default_max_backoff_ms),
      claim_operations: Keyword.get(options, :claim_operations, &Stateholder.claim_operations/3),
      media_plane: Keyword.get(options, :media_plane),
      recording_plane: Keyword.get(options, :recording_plane),
      last_success_at_ms: nil,
      consecutive_failures: 0,
      confirmed_count: 0,
      terminal_failure_count: 0,
      retained_pending_count: 0,
      active_work: %{},
      claim_work: nil,
      poll_timer: nil
    }

    send(self(), :poll)
    {:ok, state}
  end

  @impl GenServer
  def handle_call(:health, _from, state), do: {:reply, health_snapshot(state), state}

  @impl GenServer
  def handle_info(:poll, state) do
    state = %{state | poll_timer: nil}
    slots = @max_concurrency - map_size(state.active_work)

    if is_nil(state.claim_work) and slots > 0 do
      owner = self()
      excluded = Enum.map(Map.keys(state.active_work), & &1.episode_id)

      work =
        start_worker(fn ->
          result = state.claim_operations.(state.page_size, excluded, slots)
          send(owner, {:claimed, self(), result})
        end)

      {:noreply, %{state | claim_work: work}}
    else
      {:noreply, schedule_poll(state, state.poll_interval_ms)}
    end
  end

  def handle_info({:claimed, pid, result}, %{claim_work: %{pid: pid} = work} = state) do
    Process.demonitor(work.monitor_ref, [:flush])
    state = %{state | claim_work: nil}

    case result do
      {:ok, operations} ->
        Telemetry.execute([:external_operation, :poll], %{count: length(operations)}, %{
          outcome: :success
        })

        owner = self()

        active =
          operations
          |> Enum.group_by(fn {episode, _operation} -> episode end)
          |> Enum.reduce(state.active_work, fn {episode, operations}, active ->
            work = start_episode(episode, operations, state, owner)

            Map.put(active, episode, work)
          end)

        next = %{
          state
          | active_work: active,
            last_success_at_ms: now_ms(),
            consecutive_failures: 0
        }

        {:noreply, schedule_poll(next, state.poll_interval_ms)}

      {:retryable, reason} ->
        Logger.warning("sync external operation discovery unavailable: reason=#{reason}")
        {:noreply, worker_failed(state)}
    end
  end

  def handle_info({:operation_result, episode, pid, result}, state) do
    case state.active_work[episode] do
      %{pid: ^pid} = work ->
        next =
          state
          |> Map.put(:last_success_at_ms, now_ms())
          |> Map.put(
            :active_work,
            Map.put(state.active_work, episode, %{work | started_at_ms: now_ms()})
          )
          |> record_result(result)

        {:noreply, next}

      _ ->
        {:noreply, state}
    end
  end

  def handle_info({:episode_complete, episode, pid}, state) do
    case state.active_work[episode] do
      %{pid: ^pid, monitor_ref: reference} ->
        Process.demonitor(reference, [:flush])
        next = %{state | active_work: Map.delete(state.active_work, episode)}
        {:noreply, schedule_poll(next, 0)}

      _ ->
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, reference, :process, pid, reason}, state) do
    cond do
      match?(%{pid: ^pid, monitor_ref: ^reference}, state.claim_work) ->
        Logger.warning("sync external operation claim stopped: reason=#{inspect(reason)}")
        {:noreply, worker_failed(%{state | claim_work: nil})}

      episode =
          Enum.find_value(state.active_work, fn {episode, work} ->
            if work.pid == pid and work.monitor_ref == reference, do: episode
          end) ->
        Logger.warning("sync external operation worker stopped: reason=#{inspect(reason)}")
        next = %{state | active_work: Map.delete(state.active_work, episode)}
        {:noreply, worker_failed(next)}

      true ->
        {:noreply, state}
    end
  end

  def handle_info({:claimed, _pid, _result}, state), do: {:noreply, state}

  @impl GenServer
  def terminate(_reason, state) do
    for work <- [state.claim_work | Map.values(state.active_work)], not is_nil(work) do
      Process.demonitor(work.monitor_ref, [:flush])
      Process.exit(work.pid, :shutdown)
    end

    :ok
  end

  defp start_episode(episode, operations, state, owner) do
    start_worker(fn ->
      execute_episode(episode, operations, state, owner)
      send(owner, {:episode_complete, episode, self()})
    end)
  end

  defp start_worker(function) do
    {pid, reference} = spawn_monitor(function)
    %{pid: pid, monitor_ref: reference, started_at_ms: now_ms()}
  end

  defp schedule_poll(state, delay) do
    if state.poll_timer, do: Process.cancel_timer(state.poll_timer)
    %{state | poll_timer: Process.send_after(self(), :poll, delay)}
  end

  defp worker_failed(state) do
    Telemetry.execute([:external_operation, :poll], %{}, %{outcome: :failure})
    next = %{state | consecutive_failures: state.consecutive_failures + 1}
    schedule_poll(next, backoff(next))
  end

  @doc false
  @spec execute_operation(
          EpisodeKey.t(),
          ExternalOperation.t(),
          {module(), term()} | nil,
          {module(), term()} | nil,
          (EpisodeKey.t(), String.t(), tuple() -> term()),
          pos_integer()
        ) :: :confirmed | :terminal_failure | :pending | :finalization_failure
  def execute_operation(
        episode,
        operation,
        media_plane,
        recording_plane,
        finalize,
        adapter_timeout_ms \\ @default_adapter_timeout_ms
      )
      when is_function(finalize, 3) and is_integer(adapter_timeout_ms) and
             adapter_timeout_ms > 0 do
    result =
      if ExternalOperation.leave_cleanup?(operation) and operation.attempt_count >= @max_attempts,
        do: {:terminal_failure, :retry_exhausted},
        else:
          dispatch_with_context(
            episode,
            operation,
            media_plane,
            recording_plane,
            adapter_timeout_ms
          )

    case result do
      {:confirmed, authority} ->
        execution_checkpoint(:after_provider_confirmation_before_finalize, episode, operation)
        finalize_confirmed(episode, operation, authority, finalize)

      {:terminal_failure, reason} ->
        execution_checkpoint(:after_provider_terminal_failure_before_finalize, episode, operation)
        finalize_terminal_failure(episode, operation, reason, finalize)

      :pending ->
        if operation.attempt_count >= @max_attempts,
          do: finalize_terminal_failure(episode, operation, :retry_exhausted, finalize),
          else: :pending
    end
  end

  defp prepare_entry_leave(episode, %{name: :participant_leave} = operation),
    do: Stateholder.prepare_entry_leave(episode, operation.external_operation_id)

  defp prepare_entry_leave(_episode, _operation), do: :ready

  defp execute_episode(episode, operations, state, owner) do
    # Keep the master's claimed batch together and ordered within the Episode.
    # Discovery continues for other Episodes while this worker awaits the provider.
    Enum.each(operations, fn {^episode, operation} ->
      started_at = System.monotonic_time()

      result =
        execute_operation(
          episode,
          operation,
          state.media_plane,
          state.recording_plane,
          &Stateholder.finalize_operation/3,
          state.adapter_timeout_ms
        )

      report_result(operation.name, result, started_at)
      send(owner, {:operation_result, episode, self(), result})
    end)
  end

  defp record_result(state, :confirmed),
    do: %{state | confirmed_count: state.confirmed_count + 1, consecutive_failures: 0}

  defp record_result(state, :terminal_failure),
    do: %{
      state
      | terminal_failure_count: state.terminal_failure_count + 1,
        consecutive_failures: 0
    }

  defp record_result(state, :pending),
    do: %{
      state
      | retained_pending_count: state.retained_pending_count + 1,
        consecutive_failures: 0
    }

  defp record_result(state, :finalization_failure),
    do: %{state | consecutive_failures: state.consecutive_failures + 1}

  defp dispatch(_episode, %{name: name}, _media_plane, _recording_plane, _timeout_ms)
       when name in @local_operations,
       do: {:confirmed, :local}

  defp dispatch(episode, %{name: name} = operation, media_plane, recording_plane, timeout_ms)
       when name in @end_episode_operations do
    invoke_end_cleanup(media_plane, recording_plane, episode, operation, timeout_ms)
  end

  defp dispatch(episode, %{name: name} = operation, media_plane, _recording_plane, timeout_ms)
       when name in [
              :mute_participant,
              :stop_participant_camera,
              :stop_participant_screen_share,
              :remove_participant,
              :role_transition_source_stop
            ] do
    invoke_media_plane(media_plane, episode, operation, timeout_ms)
  end

  defp dispatch(episode, %{name: name} = operation, _media_plane, recording_plane, timeout_ms)
       when name in [:start_recording, :stop_recording] do
    invoke_recording_plane(recording_plane, episode, operation, timeout_ms)
  end

  defp invoke_media_plane(nil, _episode, _operation, _timeout_ms), do: :pending

  defp invoke_media_plane({module, adapter}, episode, operation, timeout_ms) do
    arguments = media_arguments(adapter, episode, operation)
    invoke_adapter(module, arguments, :provider, timeout_ms)
  end

  defp media_arguments(adapter, episode, %{name: :mute_participant} = operation),
    do: revoke_arguments(adapter, episode, operation, :microphone)

  defp media_arguments(adapter, episode, %{name: :stop_participant_camera} = operation),
    do: revoke_arguments(adapter, episode, operation, :camera)

  defp media_arguments(adapter, episode, %{name: :stop_participant_screen_share} = operation),
    do: revoke_arguments(adapter, episode, operation, :screen)

  defp media_arguments(adapter, episode, %{name: :role_transition_source_stop} = operation),
    do: revoke_arguments(adapter, episode, operation, operation.source)

  defp media_arguments(adapter, episode, %{name: name} = operation)
       when name in [:remove_participant] do
    {:remove_participant,
     [adapter, operation.external_operation_id, episode, operation.target_participant_id]}
  end

  defp media_arguments(adapter, episode, %{name: name} = operation)
       when name in @end_episode_operations,
       do: {:end_episode, [adapter, operation.external_operation_id, episode]}

  defp revoke_arguments(adapter, episode, operation, source) do
    {:revoke_publication,
     [
       adapter,
       operation.external_operation_id,
       episode,
       operation.target_participant_id,
       source
     ]}
  end

  defp invoke_recording_plane(nil, _episode, _operation, _timeout_ms), do: :pending

  defp invoke_recording_plane({module, adapter}, episode, operation, timeout_ms) do
    adapter =
      if module == ProviderBridgeRecordingPlane and is_map(operation.payload),
        do: ProviderBridgeRecordingPlane.with_operation_payload(adapter, operation.payload),
        else: adapter

    arguments =
      {operation.name,
       [adapter, operation.external_operation_id, episode, operation.recording_id]}

    invoke_adapter(module, arguments, :recording, timeout_ms)
  end

  defp invoke_end_cleanup(
         media_plane,
         _recording_plane,
         episode,
         %{recording_id: nil} = operation,
         timeout_ms
       ),
       do: invoke_media_plane(media_plane, episode, operation, timeout_ms)

  defp invoke_end_cleanup(media_plane, recording_plane, episode, operation, timeout_ms) do
    calls = [
      end_media_call(media_plane, episode, operation),
      end_recording_call(recording_plane, episode, operation)
    ]

    results =
      calls
      |> Enum.reject(&is_nil/1)
      |> invoke_adapter_calls(timeout_ms)

    missing_count = Enum.count(calls, &is_nil/1)
    combine_end_cleanup(List.duplicate(:pending, missing_count) ++ results)
  end

  defp end_media_call(nil, _episode, _operation), do: nil

  defp end_media_call({module, adapter}, episode, operation) do
    {function, arguments} = media_arguments(adapter, episode, operation)
    {module, function, arguments, :provider}
  end

  defp end_recording_call(nil, _episode, _operation), do: nil

  defp end_recording_call({module, adapter}, episode, operation) do
    {module, :stop_recording,
     [adapter, operation.external_operation_id, episode, operation.recording_id], :recording}
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

  defp finalize_confirmed(episode, operation, authority, finalize) do
    case finalize.(episode, operation.external_operation_id, {:confirmed, authority}) do
      {:ok, _decision} -> :confirmed
      result -> finalization_failure(operation.name, result)
    end
  end

  defp finalize_terminal_failure(episode, operation, reason, finalize) do
    case finalize.(episode, operation.external_operation_id, {:failed, reason}) do
      {:ok, _decision} -> :terminal_failure
      result -> finalization_failure(operation.name, result)
    end
  end

  defp execution_checkpoint(point, episode, operation) do
    case Application.get_env(:chalk_sync, :external_operation_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: episode.tenant_id,
          episode_id: episode.episode_id,
          external_operation_id: operation.external_operation_id,
          operation: operation.name
        })

      _ ->
        :ok
    end
  end

  defp finalization_failure(operation, result) do
    Logger.warning(
      "sync external operation finalization unavailable: operation=#{operation} " <>
        "result=#{inspect(result)}"
    )

    :finalization_failure
  end

  defp report_result(operation, result, started_at) do
    Telemetry.execute(
      [:external_operation, :execution],
      %{
        count: 1,
        duration_us:
          System.convert_time_unit(
            System.monotonic_time() - started_at,
            :native,
            :microsecond
          )
      },
      %{operation: operation, outcome: result}
    )
  end

  defp dispatch_with_context(episode, operation, media_plane, recording_plane, timeout_ms) do
    case prepare_entry_leave(episode, operation) do
      :ready ->
        dispatch_provider_context(episode, operation, media_plane, recording_plane, timeout_ms)

      :pending ->
        :pending

      :superseded ->
        {:terminal_failure, :participant_inactive}
    end
  end

  defp dispatch_provider_context(episode, operation, media_plane, recording_plane, timeout_ms) do
    if provider_bridge_adapter?(media_plane) or provider_bridge_adapter?(recording_plane) do
      Observability.with_worker_span(
        persisted_provider_context(operation),
        "sync.external_operation.provider_bridge",
        %{operation: operation.name},
        fn worker_context ->
          headers = Observability.frame_fields(worker_context)

          dispatch(
            episode,
            operation,
            contextual_adapter(media_plane, operation, headers),
            contextual_adapter(recording_plane, operation, headers),
            timeout_ms
          )
        end
      )
    else
      dispatch(episode, operation, media_plane, recording_plane, timeout_ms)
    end
  end

  defp provider_bridge_adapter?({module, _adapter})
       when module in [ProviderBridgeMediaPlane, ProviderBridgeRecordingPlane],
       do: true

  defp provider_bridge_adapter?(_adapter), do: false

  defp contextual_adapter(nil, _operation, _headers), do: nil

  defp contextual_adapter({ProviderBridgeMediaPlane, adapter}, operation, headers) do
    adapter =
      adapter
      |> ProviderBridgeMediaPlane.with_context(headers)
      |> ProviderBridgeMediaPlane.with_participant_generation(
        operation.target_participant_id,
        operation.target_participant_generation
      )

    {ProviderBridgeMediaPlane, adapter}
  end

  defp contextual_adapter({ProviderBridgeRecordingPlane, adapter}, _operation, headers) do
    {ProviderBridgeRecordingPlane, ProviderBridgeRecordingPlane.with_context(adapter, headers)}
  end

  defp contextual_adapter(adapter, _operation, _headers), do: adapter

  defp persisted_provider_context(operation) do
    case operation do
      %{
        journey_id: journey_id,
        producing_trace_id: trace_id,
        producing_span_id: span_id,
        producing_traceparent: traceparent,
        producing_tracestate: tracestate
      }
      when is_binary(journey_id) ->
        Observability.persisted_context(
          journey_id,
          trace_id,
          span_id,
          traceparent,
          tracestate
        )

      _other ->
        nil
    end
  end

  defp health_snapshot(state) do
    now_ms = now_ms()
    work = Enum.reject([state.claim_work | Map.values(state.active_work)], &is_nil/1)

    %{
      last_success_at_ms: state.last_success_at_ms,
      consecutive_failures: state.consecutive_failures,
      confirmed_count: state.confirmed_count,
      terminal_failure_count: state.terminal_failure_count,
      retained_pending_count: state.retained_pending_count,
      active_work: work != [],
      active_work_age_ms:
        if(work != [], do: Enum.max(Enum.map(work, &max(now_ms - &1.started_at_ms, 0)))),
      active_work_timeout_ms: state.adapter_timeout_ms + @worker_completion_grace_ms
    }
  end

  defp now_ms, do: System.monotonic_time(:millisecond)

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
