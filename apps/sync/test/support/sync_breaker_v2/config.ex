defmodule ChalkSync.SyncBreakerV2.Config do
  @moduledoc false

  @defaults %{
    seed: 2_026_071_200,
    sessions: 1,
    participants: 2,
    sockets: 2,
    subscriptions: 1,
    commands: 24,
    command_mix: [:raise_hand, :lower_hand],
    command_rate: 1_000,
    burst: 4,
    concurrency: 1,
    cursor_age: 0,
    client_read_delay_ms: 0,
    network_interrupt_every: 0,
    duration_ms: 0,
    adapter: :memory,
    database_url: nil,
    migration_version: "unverified",
    output: Path.expand("../../../.artifacts/sync", __DIR__),
    recovery_mode: :auto,
    postgres_topology: :local,
    fault_point: :none,
    notification_schedule: :none,
    restart_schedule: :none
  }

  @bounded_positive ~w(sessions participants sockets subscriptions commands command_rate burst concurrency)a
  @bounded_non_negative ~w(cursor_age client_read_delay_ms network_interrupt_every duration_ms)a
  @maxima %{
    sessions: 128,
    participants: 500,
    sockets: 5_000,
    subscriptions: 64,
    commands: 100_000,
    command_rate: 100_000,
    burst: 1_024,
    concurrency: 64,
    cursor_age: 100_000,
    client_read_delay_ms: 60_000,
    network_interrupt_every: 100_000,
    duration_ms: 28_800_000
  }

  def defaults, do: @defaults

  def new!(options) when is_list(options) do
    config = Map.merge(@defaults, Map.new(options))

    Enum.each(@bounded_positive, &validate_positive!(config, &1))
    Enum.each(@bounded_non_negative, &validate_non_negative!(config, &1))

    if config.sockets < config.participants do
      raise ArgumentError,
            "sockets must be at least participants so every participant has a replica"
    end

    if config.burst > config.commands do
      raise ArgumentError, "burst must not exceed commands"
    end

    validate_enum!(config.adapter, :adapter, [:memory, :postgres])
    validate_enum!(config.postgres_topology, :postgres_topology, [:local])
    validate_enum!(config.recovery_mode, :recovery_mode, [:auto, :snapshot, :replay])

    validate_enum!(config.fault_point, :fault_point, [
      :none,
      :before_transaction,
      :after_transaction_begin,
      :after_authority_lock,
      :after_receipt_lookup,
      :after_event_insert,
      :after_control_update,
      :after_receipt_insert,
      :before_commit,
      :after_commit_before_reply
    ])

    validate_enum!(config.notification_schedule, :notification_schedule, [:none])
    validate_enum!(config.restart_schedule, :restart_schedule, [:none])

    unless is_list(config.command_mix) and config.command_mix != [] and
             Enum.all?(config.command_mix, &(&1 in [:raise_hand, :lower_hand])) do
      raise ArgumentError, "command_mix must contain raise_hand and/or lower_hand"
    end

    if config.adapter == :memory and config.fault_point != :none do
      raise ArgumentError, "fault_point requires adapter: :postgres"
    end

    config = Map.put(config, :operation_count, operation_count(config))
    validate_operation_budget!(config)
    validate_campaign_budget!(config)
    config
  end

  def to_map(config) do
    config
    |> Map.drop([:database_url, :output])
    |> Map.new(fn {key, value} -> {Atom.to_string(key), normalize(value)} end)
  end

  defp operation_count(%{duration_ms: 0, commands: commands}), do: commands

  defp operation_count(%{duration_ms: duration_ms, command_rate: rate}),
    do: div(duration_ms * rate + 999, 1_000)

  defp validate_positive!(config, key) do
    value = Map.fetch!(config, key)
    maximum = Map.fetch!(@maxima, key)

    unless is_integer(value) and value > 0 and value <= maximum do
      raise ArgumentError, "#{key} must be an integer from 1 to #{maximum}"
    end
  end

  defp validate_non_negative!(config, key) do
    value = Map.fetch!(config, key)
    maximum = Map.fetch!(@maxima, key)

    unless is_integer(value) and value >= 0 and value <= maximum do
      raise ArgumentError, "#{key} must be an integer from 0 to #{maximum}"
    end
  end

  defp validate_enum!(value, key, values) do
    if value in values do
      :ok
    else
      allowed = Enum.map_join(values, ", ", &inspect/1)
      raise ArgumentError, "#{key} must be one of #{allowed}"
    end
  end

  defp validate_campaign_budget!(config) do
    replica_count = config.sockets * config.subscriptions
    command_duration_ms = ceil(config.operation_count * 1_000 / config.command_rate)
    read_duration_ms = replica_count * config.client_read_delay_ms

    cond do
      replica_count > 10_000 ->
        raise ArgumentError, "sockets multiplied by subscriptions must not exceed 10000"

      command_duration_ms + read_duration_ms > @maxima.duration_ms ->
        raise ArgumentError,
              "command rate and client read delay exceed the #{@maxima.duration_ms}ms campaign bound"

      true ->
        :ok
    end
  end

  defp validate_operation_budget!(%{duration_ms: 0}), do: :ok

  defp validate_operation_budget!(config) do
    cond do
      config.operation_count > @maxima.commands ->
        raise ArgumentError,
              "duration_ms=#{config.duration_ms} at command_rate=#{config.command_rate} requires " <>
                "#{config.operation_count} commands, exceeding the #{@maxima.commands} command cap"

      config.commands < config.operation_count ->
        raise ArgumentError,
              "insufficient command budget: commands must be at least #{config.operation_count} " <>
                "for duration_ms=#{config.duration_ms} at command_rate=#{config.command_rate}"

      true ->
        :ok
    end
  end

  defp normalize(value) when is_list(value), do: Enum.map(value, &normalize/1)
  defp normalize(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize(value), do: value
end
