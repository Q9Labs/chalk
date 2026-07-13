defmodule ChalkSync.SyncBreakerV3.Campaign do
  @moduledoc false

  alias ChalkSync.SyncBreakerV3.DeliveryRecoveryPhase
  alias ChalkSync.SyncBreakerV3.DurableLifecyclePhase
  alias ChalkSync.SyncBreakerV3.ExternalMediaPhase
  alias ChalkSync.SyncBreakerV3.WireSdkPhase
  alias ChalkSync.SyncPostgres

  @phase_order [
    "durable_lifecycle_reference",
    "external-operation-live-media",
    "delivery_recovery",
    "wire_sdk"
  ]

  def run!(database_url, seed \\ 730_013) when is_binary(database_url) and is_integer(seed) do
    postgres_major = postgres_major!(database_url)

    if postgres_major != 18 do
      raise "SyncEngine v3 breaker requires PostgreSQL 18, got #{postgres_major}"
    end

    phases = [
      DurableLifecyclePhase.run!(database_url, seed + 1),
      ExternalMediaPhase.run!(database_url, seed + 2),
      DeliveryRecoveryPhase.run!(database_url, seed + 3),
      WireSdkPhase.run!(database_url, seed + 4)
    ]

    true = Enum.map(phases, & &1["name"]) == @phase_order
    verdict = if Enum.all?(phases, &(&1["verdict"] == "pass")), do: "pass", else: "fail"

    %{
      "seed" => seed,
      "git_revision" => git_revision(),
      "contract_version" => 3,
      "config" => %{
        "postgres_major" => postgres_major,
        "phase_count" => length(@phase_order),
        "artifact_max_bytes" => 1_048_576
      },
      "phase_order" => @phase_order,
      "phases" => phases,
      "aggregate" => aggregate(phases),
      "verdict" => verdict
    }
  end

  defp aggregate([durable, external, delivery, wire]) do
    %{
      "receipts" => durable["receipts"] ++ external["receipts"],
      "intent_states" => durable["intent_states"] ++ external["intent_states"],
      "digest_sequence" => durable["digest_sequence"],
      "folded_snapshot" => durable["folded_snapshot"],
      "provider_projection" => external["provider_projection"],
      "delivery_evidence" => delivery["evidence"],
      "sdk_evidence" => wire["evidence"]["sdk"],
      "phase_verdicts" =>
        Map.new([durable, external, delivery, wire], &{&1["name"], &1["verdict"]}),
      "bounds" => %{
        "phases" => 4,
        "schedule_steps" =>
          Enum.sum(Enum.map([durable, external, delivery, wire], &length(&1["schedule"])))
      }
    }
  end

  defp postgres_major!(database_url) do
    [connection] = SyncPostgres.start_connections(database_url, 1)

    try do
      [[version_number]] = Postgrex.query!(connection, "show server_version_num", []).rows
      version_number |> String.to_integer() |> div(10_000)
    after
      stop(connection)
    end
  end

  defp git_revision do
    case System.cmd("git", ["rev-parse", "HEAD"], stderr_to_stdout: true) do
      {revision, 0} -> String.trim(revision)
      _error -> "unavailable"
    end
  end

  defp stop(pid) do
    if Process.alive?(pid), do: GenServer.stop(pid)
  catch
    :exit, _reason -> :ok
  end
end
