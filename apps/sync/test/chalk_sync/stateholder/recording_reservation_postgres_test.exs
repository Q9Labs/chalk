defmodule ChalkSync.Stateholder.RecordingReservationPostgresTest do
  @moduledoc """
  A Recording reserves the whole call up to its ceiling, so extending the call never leaves the
  Recording behind.
  """
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  @hour_ms 3_600_000

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 2)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  # A one-hour call that may grow to six hours.
  setup %{connection: connection} do
    now_ms = System.os_time(:millisecond)

    fixture =
      SyncPostgres.seed_episode(
        connection,
        1,
        %{
          default_episode_duration_seconds: 3_600,
          maximum_episode_duration_seconds: 21_600,
          deadline_at_ms: now_ms + @hour_ms
        },
        %{}
      )

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, fixture: fixture}
  end

  test "the reservation covers the call up to its ceiling, not only its first deadline", ctx do
    [host] = ctx.fixture.identities

    {:ok, start} =
      Operation.new("reservation_start_01", :start_recording, %{"recordingId" => UUID.generate()})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(host, start)

    assert {:ok, stored} = Postgres.read_operation(ctx.fixture.episode, id)
    seconds = stored.payload["recording_reservation"]["max_duration_seconds"]

    assert seconds > 21_600 - 120 and seconds <= 21_600
  end
end
