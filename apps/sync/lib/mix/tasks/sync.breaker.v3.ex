defmodule Mix.Tasks.Sync.Breaker.V3 do
  @moduledoc "Runs and deterministically replays the executable SyncEngine v3 breaker."

  use Mix.Task

  @shortdoc "Runs or replays the deterministic SyncEngine v3 breaker"

  @impl true
  def run(arguments) do
    if Mix.env() != :test do
      Mix.raise("sync.breaker.v3 is test-only; run it with MIX_ENV=test")
    end

    Mix.Task.run("app.start")

    {options, [], []} =
      OptionParser.parse(arguments, strict: [replay: :string, output: :string, seed: :integer])

    database_url = System.fetch_env!("CHALK_SYNC_TEST_DATABASE_URL")
    {artifact, campaign} = breaker_modules!()

    if replay = options[:replay] do
      expected = artifact.read!(replay)
      first = campaign.run!(database_url, expected["seed"])
      second = campaign.run!(database_url, expected["seed"])
      compare!(artifact, expected, first, second)
      Mix.shell().info("SyncEngine v3 replay passed twice")
    else
      result = campaign.run!(database_url, options[:seed] || 730_013)
      path = options[:output] || Path.expand(".private/sync-breaker-v3.json", File.cwd!())
      artifact.write!(path, result)
      Mix.shell().info("SyncEngine v3 breaker passed: #{path}")
    end
  end

  defp compare!(artifact, expected, first, second) do
    expected = artifact.semantic_projection(expected)
    first = artifact.semantic_projection(first)
    second = artifact.semantic_projection(second)

    unless expected == first and first == second,
      do: Mix.raise("v3 replay diverged from the recorded semantic artifact")
  end

  defp breaker_modules! do
    modules = {ChalkSync.SyncBreakerV3.Artifact, ChalkSync.SyncBreakerV3.Campaign}

    if modules |> Tuple.to_list() |> Enum.all?(&Code.ensure_loaded?/1) do
      modules
    else
      Mix.raise("SyncEngine v3 breaker support is unavailable; compile with MIX_ENV=test")
    end
  end
end
