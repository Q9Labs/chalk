alias ChalkSync.SyncBreakerV2.Campaign
alias ChalkSync.SyncBreakerV2.Replay

defmodule ChalkSync.SyncBreakerV2.Script do
  @switches [
    seed: :integer,
    sessions: :integer,
    participants: :integer,
    sockets: :integer,
    subscriptions: :integer,
    commands: :integer,
    command_mix: :string,
    command_rate: :integer,
    burst: :integer,
    concurrency: :integer,
    cursor_age: :integer,
    client_read_delay_ms: :integer,
    network_interrupt_every: :integer,
    duration_ms: :integer,
    adapter: :string,
    database_url: :string,
    migration_version: :string,
    output: :string,
    recovery_mode: :string,
    postgres_topology: :string,
    fault_point: :string,
    notification_schedule: :string,
    restart_schedule: :string
  ]

  def run(arguments), do: run(arguments, @switches)

  def run(["--" | arguments], switches), do: run(arguments, switches)

  def run(arguments, switches) do
    Application.put_env(:chalk_sync, :port, :none)
    {:ok, _apps} = Application.ensure_all_started(:chalk_sync)

    case arguments do
      [argument] when argument in ["--help", "-h", "help"] -> help()
      ["replay", path] -> replay(path)
      ["run" | options] -> campaign(options, switches)
      options -> campaign(options, switches)
    end
  end

  defp help do
    Mix.shell().info("""
    Usage:
      apps/sync/scripts/sync-breaker-v2 run [options]
      apps/sync/scripts/sync-breaker-v2 replay <artifact-directory-or-trace>

    Required campaign dimensions are explicit CLI switches. --duration-ms 0
    runs a command-count campaign; a positive duration is a minimum wall
    duration and requires enough commands for the selected --command-rate. See
    apps/sync/docs/sync-breaker-v2.md for the complete bounded examples.
    """)
  end

  defp campaign(arguments, switches) do
    {options, remaining, invalid} = OptionParser.parse(arguments, strict: switches)

    if remaining != [] or invalid != [] do
      Mix.raise("invalid sync breaker v2 arguments: #{inspect(remaining ++ invalid)}")
    end

    result = Campaign.run(normalize(options))

    Mix.shell().info(
      "#{String.upcase(to_string(result.verdict))} artifacts=#{result.run_directory}"
    )

    if result.verdict != :pass do
      Mix.raise("sync breaker v2 invariants failed; inspect #{result.run_directory}/failure.md")
    end
  end

  defp replay(path) do
    case Replay.verify(path) do
      {:ok, evidence} ->
        Mix.shell().info("PASS replay=#{evidence.trace} sessions=#{evidence.sessions}")

      {:error, reason} ->
        Mix.raise("sync breaker v2 replay failed: #{inspect(reason)}")
    end
  end

  defp normalize(options) do
    options
    |> normalize_atom(:adapter)
    |> normalize_atom(:recovery_mode)
    |> normalize_atom(:postgres_topology)
    |> normalize_atom(:fault_point)
    |> normalize_atom(:notification_schedule)
    |> normalize_atom(:restart_schedule)
    |> normalize_mix()
  end

  defp normalize_atom(options, key) do
    case Keyword.fetch(options, key) do
      {:ok, value} -> Keyword.put(options, key, parse_enum(key, value))
      :error -> options
    end
  end

  defp parse_enum(:adapter, "memory"), do: :memory
  defp parse_enum(:adapter, "postgres"), do: :postgres
  defp parse_enum(:recovery_mode, "auto"), do: :auto
  defp parse_enum(:recovery_mode, "snapshot"), do: :snapshot
  defp parse_enum(:recovery_mode, "replay"), do: :replay
  defp parse_enum(:postgres_topology, "local"), do: :local
  defp parse_enum(:fault_point, "none"), do: :none
  defp parse_enum(:fault_point, "before_transaction"), do: :before_transaction
  defp parse_enum(:fault_point, "after_transaction_begin"), do: :after_transaction_begin
  defp parse_enum(:fault_point, "after_authority_lock"), do: :after_authority_lock
  defp parse_enum(:fault_point, "after_receipt_lookup"), do: :after_receipt_lookup
  defp parse_enum(:fault_point, "after_event_insert"), do: :after_event_insert
  defp parse_enum(:fault_point, "after_control_update"), do: :after_control_update
  defp parse_enum(:fault_point, "after_receipt_insert"), do: :after_receipt_insert
  defp parse_enum(:fault_point, "before_commit"), do: :before_commit
  defp parse_enum(:fault_point, "after_commit_before_reply"), do: :after_commit_before_reply
  defp parse_enum(:notification_schedule, "none"), do: :none
  defp parse_enum(:restart_schedule, "none"), do: :none
  defp parse_enum(key, _value), do: Mix.raise("invalid #{key}")

  defp normalize_mix(options) do
    case Keyword.fetch(options, :command_mix) do
      {:ok, value} -> Keyword.put(options, :command_mix, parse_mix(value))
      :error -> options
    end
  end

  defp parse_mix(value) do
    value
    |> String.split(",", trim: true)
    |> Enum.map(fn command ->
      case command do
        "raise_hand" -> :raise_hand
        "lower_hand" -> :lower_hand
        _ -> Mix.raise("invalid command_mix command: #{command}")
      end
    end)
  end
end

ChalkSync.SyncBreakerV2.Script.run(System.argv())
