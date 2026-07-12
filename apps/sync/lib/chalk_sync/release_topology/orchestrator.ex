defmodule ChalkSync.ReleaseTopology.Orchestrator do
  @moduledoc false

  alias ChalkSync.ReleaseTopology.Command
  alias ChalkSync.ReleaseTopology.Evidence
  alias ChalkSync.ReleaseTopology.Schedule

  @version "1.0.0"
  @event_actions ~w(trigger_check inject observe telemetry cleanup)

  def run(schedule, options \\ []) do
    mode = Keyword.get(options, :mode, :dry_run)
    clock = Keyword.get(options, :clock, system_clock())

    with {:ok, schedule} <- Schedule.validate(schedule),
         :ok <- execution_allowed(schedule, mode, options),
         {:ok, artifact} <- Evidence.create(output(options), schedule["name"], clock.wall_now.()) do
      state = new_state(schedule, mode, artifact, clock, options)
      {state, verdict, error} = execute_safely(state)
      manifest = manifest(state, verdict, error)
      verdict_file = verdict_file(verdict, error, state.transitions)
      :ok = Evidence.write(artifact, manifest, state.transitions, verdict_file)

      {:ok,
       %{
         verdict: verdict,
         error: error,
         run_directory: artifact.directory,
         transitions: state.transitions
       }}
    end
  end

  defp execution_allowed(_schedule, :dry_run, _options), do: :ok

  defp execution_allowed(schedule, :execute, options) do
    environment = schedule["environment"]
    confirmation = Keyword.get(options, :confirm_environment)

    runtime_environment =
      Keyword.get(options, :runtime_environment, System.get_env("CHALK_FAILURE_ORCHESTRATOR_ENV"))

    if confirmation == environment and runtime_environment == environment do
      :ok
    else
      {:error,
       "execution requires --confirm-environment #{environment} and CHALK_FAILURE_ORCHESTRATOR_ENV=#{environment}"}
    end
  end

  defp execution_allowed(_schedule, _mode, _options),
    do: {:error, "mode must be :dry_run or :execute"}

  defp new_state(schedule, mode, artifact, clock, options) do
    %{
      artifact: artifact,
      clock: clock,
      mode: mode,
      runner: Keyword.get(options, :runner, &Command.run/1),
      schedule: schedule,
      started_at: clock.wall_now.(),
      event_started_at: nil,
      transitions: [],
      sequence: 0
    }
  end

  defp execute_safely(state) do
    execute(state)
  rescue
    error ->
      state =
        transition(state, nil, "orchestrator", "failed", %{
          "error_sha256" => Evidence.sha256(Exception.message(error))
        })

      {state, :fail, "orchestrator error"}
  catch
    kind, reason ->
      state =
        transition(state, nil, "orchestrator", "failed", %{
          "error_sha256" => Evidence.sha256("#{kind}: #{inspect(reason)}")
        })

      {state, :fail, "orchestrator exited unexpectedly"}
  end

  defp execute(%{mode: :dry_run} = state) do
    state = transition(state, nil, "run", "dry_run", %{})
    state = transition(state, nil, "topology_check", "planned", %{})

    state =
      Enum.reduce(state.schedule["events"], state, fn event, state ->
        state = transition(state, event["id"], "event", "planned", event_metadata(event))

        Enum.reduce(@event_actions, state, fn action_name, state ->
          transition(state, event["id"], action_name, "planned", %{})
        end)
      end)

    state = transition(state, nil, "breaker", "planned", %{})
    {state, :dry_run, nil}
  end

  defp execute(%{mode: :execute} = state) do
    state = transition(state, nil, "run", "started", %{})

    state = transition(state, nil, "topology_check", "scheduled", %{})

    case run_command(state, nil, "topology_check", state.schedule["topology_check"], "confirmed") do
      {state, :ok} ->
        case run_events(state.schedule["events"], state) do
          {:ok, state} -> run_breaker(state)
          {:error, state, reason} -> {state, :fail, reason}
        end

      {state, :error} ->
        state = Enum.reduce(state.schedule["events"], state, &skip_event(&2, &1))
        {state, :fail, "topology check did not confirm the declared release"}
    end
  end

  defp run_events([], state), do: {:ok, state}

  defp run_events([event | remaining], state) do
    {state, status, reason} = run_event(state, event)

    case status do
      :ok ->
        run_events(remaining, state)

      :error ->
        state = Enum.reduce(remaining, state, &skip_event(&2, &1))
        {:error, state, reason}
    end
  end

  defp run_event(state, event) do
    run_event_steps(state, event)
  rescue
    _error ->
      state = cleanup_after_exception(state, event)
      state = transition(state, event["id"], "event", "failed", %{})
      {state, :error, "event #{event["id"]} did not produce complete evidence"}
  end

  defp run_event_steps(state, event) do
    state = %{state | event_started_at: System.monotonic_time(:millisecond)}
    deadline = state.event_started_at + event["recovery_deadline_ms"]
    state = transition(state, event["id"], "event", "scheduled", event_metadata(event))
    {state, trigger_status} = run_action(state, event, "trigger_check")

    {state, action_statuses} =
      if trigger_status == :ok do
        {state, inject_status} = run_action(state, event, "inject")

        if inject_status == :ok do
          Process.sleep(min(event["duration_ms"], remaining_ms(deadline)))
          {state, observe_status} = run_action_until(state, event, "observe", deadline)
          {state, telemetry_status} = run_action_until(state, event, "telemetry", deadline)
          {state, %{inject: inject_status, observe: observe_status, telemetry: telemetry_status}}
        else
          state = skip_action(state, event, "observe")
          state = skip_action(state, event, "telemetry")
          {state, %{inject: inject_status, observe: :error, telemetry: :error}}
        end
      else
        state = skip_action(state, event, "inject")
        state = skip_action(state, event, "observe")
        state = skip_action(state, event, "telemetry")
        {state, %{inject: :error, observe: :error, telemetry: :error}}
      end

    {state, cleanup_status} = run_action_until(state, event, "cleanup", deadline)
    deadline_ok? = event_within_recovery_deadline?(state, event)

    if trigger_status == :ok and
         Enum.all?(action_statuses, fn {_name, status} -> status == :ok end) and
         cleanup_status == :ok and deadline_ok? do
      {transition(state, event["id"], "event", "completed", %{}), :ok, nil}
    else
      status = if deadline_ok?, do: "failed", else: "deadline_exceeded"
      state = transition(state, event["id"], "event", status, %{})
      {state, :error, "event #{event["id"]} did not produce complete evidence"}
    end
  end

  defp run_action_until(state, event, action_name, deadline) do
    action = Map.update!(event[action_name], "timeout_ms", &min(&1, remaining_ms(deadline)))
    run_action(state, Map.put(event, action_name, action), action_name)
  end

  defp remaining_ms(deadline), do: max(deadline - System.monotonic_time(:millisecond), 1)

  defp cleanup_after_exception(state, event) do
    injected? =
      Enum.any?(state.transitions, fn transition ->
        transition["event_id"] == event["id"] and transition["phase"] == "inject" and
          transition["status"] == "completed"
      end)

    if injected? do
      try do
        {state, _status} = run_action(state, event, "cleanup")
        state
      rescue
        _error -> state
      end
    else
      state
    end
  end

  defp event_within_recovery_deadline?(state, event) do
    elapsed_ms = System.monotonic_time(:millisecond) - state.event_started_at
    elapsed_ms <= event["recovery_deadline_ms"]
  end

  defp run_breaker(state) do
    state = transition(state, nil, "breaker", "scheduled", %{})

    case run_command(state, nil, "breaker", state.schedule["breaker"], nil) do
      {state, :ok} ->
        {transition(state, nil, "run", "completed", %{}), :pass, nil}

      {state, :error} ->
        {transition(state, nil, "run", "failed", %{}), :fail, "breaker did not pass"}
    end
  end

  defp run_action(state, event, action_name) do
    action = event[action_name]
    state = transition(state, event["id"], action_name, "scheduled", %{})
    run_command(state, event["id"], action_name, action, action["expect"])
  end

  defp run_command(state, event_id, action_name, action, expected_output) do
    case state.runner.(action) do
      {:ok, result} ->
        complete_command(state, event_id, action_name, result, expected_output)

      {:error, result} when is_map(result) ->
        state = transition(state, event_id, action_name, "failed", command_metadata(result))
        {state, :error}

      _other ->
        state =
          transition(state, event_id, action_name, "failed", %{
            "reason" => "command runner returned an invalid result"
          })

        {state, :error}
    end
  end

  defp complete_command(state, event_id, action_name, result, expected_output)
       when is_map(result) do
    output = Map.get(result, :output)

    cond do
      not is_binary(output) ->
        state =
          transition(state, event_id, action_name, "failed", %{
            "reason" => "command result omitted output"
          })

        {state, :error}

      is_binary(expected_output) and String.trim(output) != expected_output ->
        state = transition(state, event_id, action_name, "ambiguous", command_metadata(result))
        {state, :error}

      true ->
        state = transition(state, event_id, action_name, "completed", command_metadata(result))
        {state, :ok}
    end
  end

  defp complete_command(state, event_id, action_name, _result, _expected_output) do
    state =
      transition(state, event_id, action_name, "failed", %{
        "reason" => "command runner returned an invalid result"
      })

    {state, :error}
  end

  defp skip_event(state, event) do
    state = transition(state, event["id"], "event", "skipped", event_metadata(event))
    Enum.reduce(@event_actions, state, &skip_action(&2, event, &1))
  end

  defp skip_action(state, event, action_name),
    do: transition(state, event["id"], action_name, "skipped", %{})

  defp transition(state, event_id, phase, status, metadata) do
    record =
      metadata
      |> Map.merge(%{
        "at" => DateTime.to_iso8601(state.clock.wall_now.()),
        "event_id" => event_id,
        "monotonic_ms" => state.clock.monotonic_ms.(),
        "phase" => phase,
        "sequence" => state.sequence + 1,
        "status" => status
      })

    %{state | sequence: state.sequence + 1, transitions: state.transitions ++ [record]}
  end

  defp command_metadata(result) do
    %{}
    |> maybe_put("duration_ms", Map.get(result, :duration_ms))
    |> maybe_put("exit_code", Map.get(result, :exit_code))
    |> maybe_put_reason_digest(Map.get(result, :reason))
    |> maybe_put_output_digest(Map.get(result, :output))
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp maybe_put_reason_digest(map, reason) when is_binary(reason),
    do: Map.put(map, "reason_sha256", Evidence.sha256(reason))

  defp maybe_put_reason_digest(map, _reason), do: map

  defp maybe_put_output_digest(map, output) when is_binary(output),
    do: Map.put(map, "stdout_sha256", Evidence.sha256(output))

  defp maybe_put_output_digest(map, _output), do: map

  defp event_metadata(event) do
    Map.take(event, [
      "trigger",
      "duration_ms",
      "expected_readiness",
      "expected_client_outcome",
      "recovery_deadline_ms",
      "invariants"
    ])
  end

  defp manifest(state, verdict, error) do
    ended_at = state.clock.wall_now.()

    %{
      "kind" => "chalk_sync_release_topology_failure_schedule",
      "orchestrator_version" => @version,
      "environment" => state.schedule["environment"],
      "execution_mode" => Atom.to_string(state.mode),
      "run_id" => state.artifact.run_id,
      "schedule" => Schedule.sanitized(state.schedule),
      "schedule_sha256" => Schedule.digest(state.schedule),
      "started_at" => DateTime.to_iso8601(state.started_at),
      "ended_at" => DateTime.to_iso8601(ended_at),
      "transitions_sha256" => state.transitions |> JSON.encode!() |> Evidence.sha256(),
      "verdict" => Atom.to_string(verdict),
      "error" => error,
      "dependency_versions" => %{
        "chalk_sync" => Application.spec(:chalk_sync, :vsn) |> to_string(),
        "elixir" => System.version(),
        "otp" => System.otp_release()
      }
    }
  end

  defp verdict_file(verdict, error, transitions) do
    %{
      "verdict" => Atom.to_string(verdict),
      "error" => error,
      "transition_count" => length(transitions)
    }
  end

  defp output(options),
    do: Keyword.get(options, :output, Path.expand(".artifacts/release-topology"))

  defp system_clock do
    %{
      wall_now: &DateTime.utc_now/0,
      monotonic_ms: fn -> System.monotonic_time(:millisecond) end
    }
  end
end
