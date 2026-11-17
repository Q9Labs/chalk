defmodule ChalkSync.Stateholder.ExtendEpisodePostgresTest do
  @moduledoc """
  Extending an Episode moves its deadline by the requested time, never past the ceiling its
  configuration fixed, and records the move as one control event.
  """
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Command
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

  # A one-hour call that may grow to two hours.
  setup %{connection: connection} do
    created_ms = System.os_time(:millisecond)

    fixture =
      SyncPostgres.seed_episode(
        connection,
        2,
        %{
          default_episode_duration_seconds: 3_600,
          maximum_episode_duration_seconds: 7_200,
          deadline_at_ms: created_ms + @hour_ms
        },
        %{}
      )

    Postgrex.query!(
      connection,
      "update episodes set created_at = to_timestamp($2::double precision / 1000.0) where id = $1",
      [UUID.dump!(fixture.episode.episode_id), created_ms]
    )

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, fixture: fixture, created_ms: created_ms}
  end

  test "an extension moves the deadline and the replicated deadline together", ctx do
    [host | _] = ctx.fixture.identities

    assert {:ok, %{result: :committed, event: event}} = extend(host, 1_800)

    assert event.name == "deadline_changed"
    assert event.payload["deadline_generation"] == 2
    assert event.payload["deadline_at_ms"] == ctx.created_ms + @hour_ms + 1_800_000
    assert episode_deadline_ms(ctx) == event.payload["deadline_at_ms"]
  end

  test "an extension past the ceiling stops at the ceiling", ctx do
    [host | _] = ctx.fixture.identities

    assert {:ok, %{result: :committed, event: event}} = extend(host, 4 * 3_600)

    assert event.payload["deadline_at_ms"] == ctx.created_ms + 2 * @hour_ms
    assert episode_deadline_ms(ctx) == ctx.created_ms + 2 * @hour_ms
  end

  test "an Episode already at its ceiling has nothing to extend", ctx do
    [host | _] = ctx.fixture.identities
    assert {:ok, %{result: :committed}} = extend(host, 4 * 3_600)

    assert {:ok, %{result: :rejected, reason: :invalid_state}} = extend(host, 60)
    assert episode_deadline_ms(ctx) == ctx.created_ms + 2 * @hour_ms
  end

  test "a Participant without the extend capability is refused", ctx do
    [_host, guest] = ctx.fixture.identities

    assert {:ok, %{result: :rejected, reason: :capability_denied}} = extend(guest, 60)
    assert episode_deadline_ms(ctx) == ctx.created_ms + @hour_ms
  end

  defp extend(identity, seconds) do
    {:ok, command} =
      Command.new(UUID.generate(), :extend_episode, %{"extensionSeconds" => seconds})

    Postgres.decide_command(identity, command)
  end

  defp episode_deadline_ms(ctx) do
    %{rows: [[ms]]} =
      Postgrex.query!(
        ctx.connection,
        "select (extract(epoch from deadline_at) * 1000)::bigint from episodes where id = $1",
        [UUID.dump!(ctx.fixture.episode.episode_id)]
      )

    ms
  end
end
