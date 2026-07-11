defmodule Mix.Tasks.Sync.Breaker do
  @moduledoc false
  @shortdoc "Stress-tests the local Chalk sync engine with deterministic histories and faults"

  use Mix.Task

  @switches [
    seed: :integer,
    cases: :integer,
    steps: :integer,
    participants: :integer,
    retries: :boolean,
    writer_restarts: :boolean,
    output: :string,
    scenarios: :string
  ]

  @impl Mix.Task
  def run(arguments) do
    if Mix.env() != :test do
      Mix.raise("sync.breaker is test-only; run it with MIX_ENV=test")
    end

    {options, remaining, invalid} = OptionParser.parse(arguments, strict: @switches)

    if remaining != [] or invalid != [] do
      Mix.raise("invalid sync.breaker arguments: #{inspect(remaining ++ invalid)}")
    end

    Application.put_env(:chalk_sync, :port, :none)
    Mix.Task.run("app.start")

    campaign = breaker_module!()
    options = normalize_scenarios(options, campaign)
    result = campaign.run(options)

    Mix.shell().info("#{String.upcase(to_string(result.verdict))} report=#{result.report}")

    if result.verdict == :fail do
      Mix.raise("sync invariants failed; inspect #{result.report}")
    end
  end

  defp normalize_scenarios(options, campaign) do
    case Keyword.pop(options, :scenarios) do
      {nil, options} ->
        Keyword.put(options, :scenarios, :all)

      {scenarios, options} ->
        selected = String.split(scenarios, ",", trim: true)
        unknown = selected -- campaign.scenario_names()

        cond do
          selected == [] ->
            Mix.raise("at least one sync.breaker scenario must be selected")

          unknown != [] ->
            Mix.raise("unknown scenarios: #{Enum.join(unknown, ", ")}")

          true ->
            Keyword.put(options, :scenarios, selected)
        end
    end
  end

  defp breaker_module! do
    module = ChalkSync.SyncBreaker.Campaign

    if Code.ensure_loaded?(module) do
      module
    else
      Mix.raise("sync breaker support is unavailable; compile with MIX_ENV=test")
    end
  end
end
