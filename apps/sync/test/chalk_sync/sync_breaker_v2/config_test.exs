defmodule ChalkSync.SyncBreakerV2.ConfigTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreakerV2.Config

  test "requires bounded explicit dimensions and no named profiles" do
    config =
      Config.new!(
        seed: 77,
        sessions: 2,
        participants: 3,
        sockets: 3,
        subscriptions: 2,
        commands: 20,
        command_rate: 100,
        burst: 5,
        concurrency: 2,
        cursor_age: 4,
        client_read_delay_ms: 10,
        network_interrupt_every: 0,
        duration_ms: 51,
        command_mix: [:raise_hand],
        recovery_mode: :replay
      )

    assert config.operation_count == 6

    assert Config.to_map(config) == %{
             "adapter" => "memory",
             "burst" => 5,
             "client_read_delay_ms" => 10,
             "command_mix" => ["raise_hand"],
             "command_rate" => 100,
             "commands" => 20,
             "concurrency" => 2,
             "cursor_age" => 4,
             "duration_ms" => 51,
             "fault_point" => "none",
             "migration_version" => "unverified",
             "network_interrupt_every" => 0,
             "notification_schedule" => "none",
             "operation_count" => 6,
             "participants" => 3,
             "postgres_topology" => "local",
             "recovery_mode" => "replay",
             "restart_schedule" => "none",
             "seed" => 77,
             "sessions" => 2,
             "sockets" => 3,
             "subscriptions" => 2
           }
  end

  test "requires enough commands to sustain a duration campaign" do
    assert_raise ArgumentError,
                 "insufficient command budget: commands must be at least 6 for duration_ms=51 at command_rate=100",
                 fn ->
                   Config.new!(commands: 5, command_rate: 100, duration_ms: 51)
                 end
  end

  test "accepts the eight-hour low-rate campaign within the command cap" do
    config =
      Config.new!(
        commands: 28_800,
        command_rate: 1,
        duration_ms: 28_800_000
      )

    assert config.operation_count == 28_800
  end

  test "reports the true duration maximum" do
    assert_raise ArgumentError, "duration_ms must be an integer from 0 to 28800000", fn ->
      Config.new!(duration_ms: 28_800_001)
    end
  end

  test "keeps duration-zero campaigns command-count bounded" do
    config = Config.new!(commands: 20, command_rate: 100, duration_ms: 0)

    assert config.operation_count == 20
  end

  test "rejects unsupported operational schedules instead of accepting a profile name" do
    assert_raise ArgumentError, ~r/notification_schedule/, fn ->
      Config.new!(notification_schedule: :drop_all)
    end

    assert_raise ArgumentError, ~r/fault_point requires adapter/, fn ->
      Config.new!(fault_point: :after_commit_before_reply)
    end
  end
end
