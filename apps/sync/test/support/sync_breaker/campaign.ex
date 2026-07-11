defmodule ChalkSync.SyncBreaker.Campaign do
  @moduledoc false

  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.SyncBreaker.Checker
  alias ChalkSync.SyncBreaker.FaultScenarios
  alias ChalkSync.SyncBreaker.Generator
  alias ChalkSync.SyncBreaker.RandomWireCampaign
  alias ChalkSync.SyncBreaker.Report
  alias ChalkSync.SyncBreaker.Result
  alias ChalkSync.SyncBreaker.Scenarios
  alias ChalkSync.SyncBreaker.TraceWriter
  alias ChalkSync.Transport.Router

  @default_seed 872_193
  @default_cases 8
  @default_steps 250
  @default_participants 6

  def run(options \\ []) do
    config = config(options)
    run_directory = Report.create_run_directory(config.output, config.seed)
    reset_memory_stateholder()
    {:ok, listener} = Bandit.start_link(plug: Router, port: 0)
    {:ok, {_address, port}} = ThousandIsland.listener_info(listener)

    try do
      results = execute(config, port, run_directory)
      metadata = metadata(config, port)
      results = write_result_traces(run_directory, results)
      :ok = Report.write(run_directory, metadata, results)

      %{
        verdict: if(Enum.all?(results, &(&1.status == :pass)), do: :pass, else: :fail),
        results: results,
        run_directory: run_directory,
        report: Path.join(run_directory, "report.md")
      }
    after
      if Process.alive?(listener), do: Supervisor.stop(listener)
      reset_memory_stateholder()
    end
  end

  def scenario_names do
    [
      "model",
      "random_wire",
      "idempotency_retry_after_writer_restart",
      "reconnect_replay_convergence",
      "replay_revision_jump_probe",
      "commit_ambiguity",
      "writer_conflict_orphan",
      "idempotency_eviction",
      "slow_subscriber",
      "retention_snapshot_fallback",
      "multiple_subscriptions_lifecycle"
    ]
  end

  defp execute(config, port, run_directory) do
    seeds = Enum.to_list(config.seed..(config.seed + config.cases - 1))

    model_results =
      if selected?(config, "model") do
        Enum.map(seeds, &run_model_case(&1, config, run_directory))
      else
        []
      end

    wire_results =
      if selected?(config, "random_wire") do
        Enum.map(seeds, fn seed ->
          RandomWireCampaign.run_case(port, seed,
            participants: config.participants,
            steps: config.steps,
            retries: config.retries,
            writer_restarts: config.writer_restarts
          )
        end)
      else
        []
      end

    focused_results =
      [
        {"idempotency_retry_after_writer_restart",
         fn -> Scenarios.idempotency_retry_after_writer_restart(port) end},
        {"reconnect_replay_convergence", fn -> Scenarios.reconnect_replay_convergence(port) end},
        {"replay_revision_jump_probe", &Scenarios.replay_revision_jump_probe/0}
      ]
      |> run_selected(config)

    fault_results =
      [
        {"commit_ambiguity", fn -> FaultScenarios.commit_ambiguity(config.seed) end},
        {"writer_conflict_orphan", fn -> FaultScenarios.writer_conflict_orphan(config.seed) end},
        {"idempotency_eviction", fn -> FaultScenarios.idempotency_eviction(config.seed) end},
        {"slow_subscriber", fn -> FaultScenarios.slow_subscriber(config.seed) end},
        {"retention_snapshot_fallback",
         fn -> FaultScenarios.retention_snapshot_fallback(config.seed) end},
        {"multiple_subscriptions_lifecycle",
         fn -> FaultScenarios.multiple_subscriptions_lifecycle(config.seed) end}
      ]
      |> run_selected(config)

    model_results ++ wire_results ++ focused_results ++ fault_results
  end

  defp run_selected(scenarios, config) do
    Enum.flat_map(scenarios, fn {name, run} ->
      if selected?(config, name), do: [safe_run(name, run)], else: []
    end)
  end

  defp run_model_case(seed, config, run_directory) do
    generated =
      Generator.generate(seed, operations: config.steps, participants: config.participants)

    case Checker.check(generated.history) do
      :ok ->
        {:ok, trace_path} =
          TraceWriter.write(run_directory, generated, name: "model-#{seed}.jsonl")

        Result.pass("model", seed: seed, evidence: %{"trace" => trace_path})

      {:error, failure} ->
        artifact = Map.put(generated, :failure, failure)

        {:ok, trace_path} =
          TraceWriter.write(run_directory, artifact, name: "model-#{seed}.jsonl")

        Result.fail("model", failure.invariant, failure.message,
          seed: seed,
          evidence: Map.put(failure.details, "trace", trace_path)
        )
    end
  end

  defp safe_run(name, run) do
    run.()
  rescue
    exception -> Result.error(name, exception, stacktrace: __STACKTRACE__)
  catch
    kind, reason ->
      Result.fail(name, :scenario_exit, Exception.format_banner(kind, reason),
        evidence: %{"kind" => to_string(kind), "reason" => inspect(reason)}
      )
  end

  defp write_result_traces(run_directory, results) do
    results
    |> Enum.with_index(1)
    |> Enum.map(fn {result, index} ->
      path =
        Path.join(run_directory, "#{index}-#{result.scenario}-#{result.seed || "none"}.jsonl")

      manifest = %{
        "kind" => "manifest",
        "schema_version" => 1,
        "scenario" => result.scenario,
        "seed" => result.seed,
        "status" => Atom.to_string(result.status),
        "invariant" => result.invariant && Atom.to_string(result.invariant)
      }

      records =
        result.trace
        |> Enum.with_index(1)
        |> Enum.map(fn {record, sequence} ->
          %{"kind" => "trace", "sequence" => sequence, "record" => record}
        end)

      lines = Enum.map_join([manifest | records], "\n", &JSON.encode!/1)

      File.write!(path, lines <> "\n")
      %{result | evidence: Map.put(result.evidence, "result_trace", path)}
    end)
  end

  defp config(options) do
    scenarios = Keyword.get(options, :scenarios, :all)

    %{
      seed: positive_option(options, :seed, @default_seed),
      cases: positive_option(options, :cases, @default_cases),
      steps: positive_option(options, :steps, @default_steps),
      participants: positive_option(options, :participants, @default_participants),
      retries: boolean_option(options, :retries, true),
      writer_restarts: boolean_option(options, :writer_restarts, true),
      output: Keyword.get(options, :output, default_output()),
      scenarios: scenarios
    }
  end

  defp boolean_option(options, key, default) do
    case Keyword.get(options, key, default) do
      value when is_boolean(value) -> value
      value -> raise ArgumentError, "#{key} must be a boolean, got: #{inspect(value)}"
    end
  end

  defp positive_option(options, key, default) do
    case Keyword.get(options, key, default) do
      value when is_integer(value) and value > 0 -> value
      value -> raise ArgumentError, "#{key} must be a positive integer, got: #{inspect(value)}"
    end
  end

  defp selected?(%{scenarios: :all}, _name), do: true
  defp selected?(%{scenarios: scenarios}, name), do: name in scenarios

  defp metadata(config, port) do
    {git_revision, _status} = System.cmd("git", ["rev-parse", "HEAD"], stderr_to_stdout: true)
    {dirty_state, _status} = System.cmd("git", ["status", "--short"], stderr_to_stdout: true)

    %{
      "seed" => config.seed,
      "cases" => config.cases,
      "steps" => config.steps,
      "participants" => config.participants,
      "retries" => config.retries,
      "writer_restarts" => config.writer_restarts,
      "scenarios" => if(config.scenarios == :all, do: scenario_names(), else: config.scenarios),
      "listener" => "127.0.0.1:#{port}",
      "git_revision" => String.trim(git_revision),
      "dirty_fingerprint" => :crypto.hash(:sha256, dirty_state) |> Base.encode16(case: :lower),
      "elixir" => System.version(),
      "otp" => System.otp_release()
    }
  end

  defp default_output do
    Path.expand("../../../../../.private/sync-breaker", __DIR__)
  end

  defp reset_memory_stateholder do
    if Stateholder.impl() == Memory, do: Memory.reset()
  end
end
