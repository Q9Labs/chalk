defmodule ChalkSync.SyncBreakerV2.TraceArtifact do
  @moduledoc false

  alias ChalkSync.SyncBreakerV2.Config

  def create(config) do
    git_sha = git_sha()
    dirty_state = git_dirty_state()
    timestamp = DateTime.utc_now() |> DateTime.to_unix(:millisecond)
    run_id = "seed-#{config.seed}-#{timestamp}-#{System.unique_integer([:positive, :monotonic])}"
    directory = Path.join([config.output, git_sha, run_id])
    :ok = File.mkdir_p(directory)

    %{
      directory: directory,
      git_sha: git_sha,
      run_id: run_id,
      dirty_worktree: dirty_state != "",
      dirty_status_sha256: sha256(dirty_state)
    }
  end

  def write(artifact, config, result) do
    manifest = %{
      "kind" => "chalk_sync_breaker_v2",
      "run_id" => artifact.run_id,
      "git_sha" => artifact.git_sha,
      "dirty_worktree" => artifact.dirty_worktree,
      "dirty_status_sha256" => artifact.dirty_status_sha256,
      "generated_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "protocol_version" => 2,
      "migration_version" => config.migration_version,
      "dimensions" => Config.to_map(config),
      "database" => %{
        "adapter" => Atom.to_string(config.adapter),
        "postgres_topology" => Atom.to_string(config.postgres_topology),
        "database_url_configured" => is_binary(config.database_url)
      },
      "dependency_versions" => dependency_versions()
    }

    verdict = %{
      "verdict" => result.verdict,
      "invariants" => result.invariants,
      "error" => result.error
    }

    write_json!(artifact.directory, "manifest.json", manifest)
    write_json!(artifact.directory, "verdict.json", verdict)
    write_json!(artifact.directory, "metrics.json", result.metrics)

    write_json!(artifact.directory, "reproducer.json", %{
      "config" => Config.to_map(config),
      "replay_command" => "apps/sync/scripts/sync-breaker-v2 replay #{artifact.directory}"
    })

    write_trace!(artifact.directory, result.trace)
    write_logs!(artifact.directory, config.adapter)
    write_failure!(artifact.directory, verdict)
    :ok
  end

  def read_trace(path) do
    with {:ok, contents} <- File.read(path) do
      decode_trace(contents)
    end
  end

  defp write_trace!(directory, trace) do
    path = Path.join(directory, "trace.jsonl")

    File.open!(path, [:write, :binary], fn file ->
      trace
      |> Enum.with_index(1)
      |> Enum.each(fn {record, sequence} ->
        IO.binwrite(
          file,
          JSON.encode!(%{"sequence" => sequence, "record" => normalize(record)}) <> "\n"
        )
      end)
    end)
  end

  defp write_logs!(directory, adapter) do
    File.write!(
      Path.join(directory, "server.log"),
      "No long-lived server process was started by this adapter campaign.\n"
    )

    File.write!(
      Path.join(directory, "client.log"),
      "Replica checks are captured in trace.jsonl.\n"
    )

    postgres_log =
      if adapter == :postgres,
        do: "Postgres adapter decisions are represented by redacted trace records.\n",
        else: "Postgres adapter was not selected.\n"

    File.write!(Path.join(directory, "postgres.log"), postgres_log)
  end

  defp write_failure!(directory, %{"verdict" => "PASS"}) do
    File.write!(
      Path.join(directory, "failure.md"),
      "# Sync breaker v2 failure\n\nNo invariant failures.\n"
    )
  end

  defp write_failure!(directory, verdict) do
    failed = Enum.filter(verdict["invariants"], &(&1["status"] == "FAIL"))

    details =
      Enum.map_join(failed, "\n", fn invariant ->
        "## `#{invariant["name"]}`\n\n" <>
          "Observed mismatch: #{invariant["detail"]}\n\n" <>
          "First bad revision or receipt: #{invariant["detail"]}\n"
      end)

    File.write!(
      Path.join(directory, "failure.md"),
      "# Sync breaker v2 failure\n\n#{details}\n" <>
        "\nMinimal reproduction: `apps/sync/scripts/sync-breaker-v2 replay #{directory}`\n" <>
        "Relevant trace: `trace.jsonl`\n" <>
        "Error: #{verdict["error"] || "none"}\n"
    )
  end

  defp write_json!(directory, name, value),
    do: File.write!(Path.join(directory, name), JSON.encode!(normalize(value)) <> "\n")

  defp decode_trace(contents) do
    contents
    |> String.split("\n", trim: true)
    |> Enum.reduce_while({:ok, []}, &decode_trace_record/2)
    |> reverse_trace_records()
  end

  defp decode_trace_record(line, {:ok, records}) do
    case JSON.decode(line) do
      {:ok, record} -> {:cont, {:ok, [record | records]}}
      {:error, reason} -> {:halt, {:error, reason}}
    end
  end

  defp reverse_trace_records({:ok, records}), do: {:ok, Enum.reverse(records)}
  defp reverse_trace_records(error), do: error

  defp git_sha do
    case System.cmd("git", ["rev-parse", "--short=12", "HEAD"], stderr_to_stdout: true) do
      {sha, 0} -> String.trim(sha)
      _ -> "unknown"
    end
  end

  defp git_dirty_state do
    case System.cmd("git", ["status", "--short"], stderr_to_stdout: true) do
      {status, 0} -> status
      _ -> "git-status-unavailable"
    end
  end

  defp sha256(value),
    do: :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)

  defp dependency_versions do
    %{
      "chalk_sync" => Application.spec(:chalk_sync, :vsn) |> to_string(),
      "elixir" => System.version(),
      "otp" => System.otp_release()
    }
  end

  defp normalize(map) when is_map(map),
    do: Map.new(map, fn {key, value} -> {to_string(key), normalize(value)} end)

  defp normalize(list) when is_list(list), do: Enum.map(list, &normalize/1)
  defp normalize(nil), do: nil
  defp normalize(value) when is_boolean(value), do: value
  defp normalize(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize(value) when is_tuple(value), do: value |> Tuple.to_list() |> normalize()
  defp normalize(value), do: value
end
