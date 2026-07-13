defmodule Mix.Tasks.Sync.Breaker.V3 do
  @moduledoc "Runs and deterministically replays the executable SyncEngine v3 breaker."

  use Mix.Task

  alias ChalkSync.SyncBreakerV3.{Artifact, Campaign}

  @shortdoc "Runs or replays the deterministic SyncEngine v3 breaker"

  @impl true
  def run(arguments) do
    Mix.Task.run("app.start")

    {options, [], []} =
      OptionParser.parse(arguments, strict: [replay: :string, output: :string, seed: :integer])

    database_url = System.fetch_env!("CHALK_SYNC_TEST_DATABASE_URL")

    if replay = options[:replay] do
      expected = Artifact.read!(replay)
      first = Campaign.run!(database_url, expected["seed"])
      second = Campaign.run!(database_url, expected["seed"])
      compare!(expected, first, second)
      Mix.shell().info("SyncEngine v3 replay passed twice")
    else
      campaign = Campaign.run!(database_url, options[:seed] || 730_013)
      path = options[:output] || Path.expand(".private/sync-breaker-v3.json", File.cwd!())
      Artifact.write!(path, campaign)
      Mix.shell().info("SyncEngine v3 breaker passed: #{path}")
    end
  end

  defp compare!(expected, first, second) do
    expected = Artifact.semantic_projection(expected)
    first = Artifact.semantic_projection(first)
    second = Artifact.semantic_projection(second)

    unless expected == first and first == second,
      do: Mix.raise("v3 replay diverged from the recorded semantic artifact")
  end
end
