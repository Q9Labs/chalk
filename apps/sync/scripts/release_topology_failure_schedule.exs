alias ChalkSync.ReleaseTopology.Orchestrator
alias ChalkSync.ReleaseTopology.Schedule

defmodule ChalkSync.ReleaseTopology.Script do
  @switches [
    schedule: :string,
    output: :string,
    execute: :boolean,
    confirm_environment: :string
  ]

  def run(["--" | arguments]), do: run(arguments)

  def run(arguments) do
    case arguments do
      [argument] when argument in ["--help", "-h", "help"] -> help()
      _arguments -> schedule(arguments)
    end
  end

  defp help do
    Mix.shell().info("""
    Usage:
      apps/sync/scripts/release-topology-failure-schedule --schedule <schedule.json>
      apps/sync/scripts/release-topology-failure-schedule --schedule <schedule.json> --execute --confirm-environment local

    The default is a non-mutating dry run. Execution requires a matching
    CHALK_FAILURE_ORCHESTRATOR_ENV value of local or staging. Production is not
    a supported schedule environment.
    """)
  end

  defp schedule(arguments) do
    {options, remaining, invalid} = OptionParser.parse(arguments, strict: @switches)

    if remaining != [] or invalid != [] do
      Mix.raise("invalid release-topology scheduler arguments: #{inspect(remaining ++ invalid)}")
    end

    schedule_path = Keyword.get(options, :schedule) || Mix.raise("--schedule is required")
    mode = if Keyword.get(options, :execute, false), do: :execute, else: :dry_run

    with {:ok, schedule} <- Schedule.load(expand_from_caller(schedule_path)),
         {:ok, result} <-
           Orchestrator.run(schedule,
             mode: mode,
             output: output(options),
             confirm_environment: Keyword.get(options, :confirm_environment)
           ) do
      report(result)
    else
      {:error, reason} -> Mix.raise("release-topology scheduler failed: #{reason}")
    end
  end

  defp report(%{verdict: :dry_run, run_directory: directory}) do
    Mix.shell().info("DRY_RUN artifacts=#{directory}")
  end

  defp report(%{verdict: :pass, run_directory: directory}) do
    Mix.shell().info("PASS artifacts=#{directory}")
  end

  defp report(%{verdict: :fail, run_directory: directory, error: error}) do
    Mix.raise("release-topology scheduler failed: #{error}; artifacts=#{directory}")
  end

  defp output(options) do
    case Keyword.fetch(options, :output) do
      {:ok, output} -> expand_from_caller(output)
      :error -> Path.expand(".artifacts/release-topology")
    end
  end

  defp expand_from_caller(path) do
    caller_directory =
      System.get_env("CHALK_FAILURE_ORCHESTRATOR_CALLER_DIRECTORY") || File.cwd!()

    Path.expand(path, caller_directory)
  end
end

ChalkSync.ReleaseTopology.Script.run(System.argv())
