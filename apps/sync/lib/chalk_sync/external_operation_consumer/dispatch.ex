defmodule ChalkSync.ExternalOperationConsumer.Dispatch do
  @moduledoc """
  Builds the provider context of an external operation and calls the media or recording plane adapter.
  """

  require Logger
  alias ChalkSync.Observability
  alias ChalkSync.ProviderCall
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.OperationTable
  require OperationTable

  defp prepare_entry_leave(episode, %{name: :participant_leave} = operation),
    do: Stateholder.prepare_entry_leave(episode, operation.external_operation_id)

  defp prepare_entry_leave(_episode, _operation), do: :ready

  defp dispatch(_episode, %{name: name}, _media_plane, _recording_plane, _timeout_ms)
       when OperationTable.is_local_name(name),
       do: {:confirmed, :local}

  defp dispatch(episode, %{name: name} = operation, media_plane, recording_plane, timeout_ms)
       when OperationTable.is_episode_end_name(name) do
    invoke_end_cleanup(media_plane, recording_plane, episode, operation, timeout_ms)
  end

  defp dispatch(episode, %{name: name} = operation, media_plane, _recording_plane, timeout_ms)
       when OperationTable.is_media_name(name) do
    invoke_media_plane(media_plane, episode, operation, timeout_ms)
  end

  defp dispatch(episode, %{name: name} = operation, _media_plane, recording_plane, timeout_ms)
       when OperationTable.is_recording_name(name) do
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
       when OperationTable.is_episode_end_name(name),
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

  def dispatch_with_context(episode, operation, media_plane, recording_plane, timeout_ms) do
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
    if ProviderCall.contextual?(media_plane) or ProviderCall.contextual?(recording_plane) do
      Observability.with_worker_span(
        persisted_provider_context(operation),
        "sync.external_operation.provider_bridge",
        %{operation: operation.name},
        fn worker_context ->
          call = provider_call(operation, Observability.frame_fields(worker_context))

          dispatch(
            episode,
            operation,
            ProviderCall.attach(media_plane, call),
            ProviderCall.attach(recording_plane, call),
            timeout_ms
          )
        end
      )
    else
      dispatch(episode, operation, media_plane, recording_plane, timeout_ms)
    end
  end

  defp provider_call(operation, headers) do
    call = %{
      headers: headers,
      control_revision: operation.control_revision,
      participant_id: operation.target_participant_id,
      participant_generation: operation.target_participant_generation
    }

    if OperationTable.is_recording_name(operation.name) and is_map(operation.payload),
      do: Map.put(call, :payload, operation.payload),
      else: call
  end

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
end
