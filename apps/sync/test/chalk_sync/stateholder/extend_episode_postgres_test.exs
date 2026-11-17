defmodule ChalkSync.Stateholder.ExtendEpisodePostgresTest do
  @moduledoc """
  Extending an Episode is a Sync operation. It moves the deadline by the requested time, never past
  the ceiling its configuration fixed, and records the move as one `deadline_changed` event that
  names the operation, the shape deployed v1 clients already understand.
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
          deadline_at_ms: created_ms + @hour_ms,
          deadline_generation: 2
        },
        %{}
      )

    Postgrex.query!(
      connection,
      "update episodes set created_at = to_timestamp($2::double precision / 1000.0), deadline_at = to_timestamp($3::double precision / 1000.0), deadline_generation = 2 where id = $1",
      [UUID.dump!(fixture.episode.episode_id), created_ms, created_ms + @hour_ms]
    )

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, fixture: fixture, created_ms: created_ms}
  end

  test "an extension moves the deadline and the replicated deadline together", ctx do
    [host | _] = ctx.fixture.identities

    assert {:ok, %{result: :applied, external_operation_id: id}} = extend(host, 1_800)

    event = deadline_event(ctx)
    assert event.external_operation_id == id
    assert event.payload["deadline_generation"] == 3
    assert event.payload["deadline_at_ms"] == ctx.created_ms + @hour_ms + 1_800_000
    assert episode_deadline_ms(ctx) == event.payload["deadline_at_ms"]
  end

  test "an extension past the ceiling stops at the ceiling", ctx do
    [host | _] = ctx.fixture.identities

    assert {:ok, %{result: :applied}} = extend(host, 4 * 3_600)

    assert deadline_event(ctx).payload["deadline_at_ms"] == ctx.created_ms + 2 * @hour_ms
    assert episode_deadline_ms(ctx) == ctx.created_ms + 2 * @hour_ms
  end

  test "an Episode already at its ceiling has nothing to extend", ctx do
    [host | _] = ctx.fixture.identities
    assert {:ok, %{result: :applied}} = extend(host, 4 * 3_600)

    assert {:ok, %{result: :rejected, reason: :invalid_state}} = extend(host, 60)
    assert episode_deadline_ms(ctx) == ctx.created_ms + 2 * @hour_ms
  end

  test "a Participant without the extend capability is refused", ctx do
    [_host, guest] = ctx.fixture.identities

    assert {:ok, %{result: :rejected, reason: :capability_denied}} = extend(guest, 60)
    assert episode_deadline_ms(ctx) == ctx.created_ms + @hour_ms
  end

  test "an extension leaves no pending operation for another node to find", ctx do
    [host | _] = ctx.fixture.identities
    assert {:ok, %{result: :applied, external_operation_id: id}} = extend(host, 600)

    %{rows: [[status]]} =
      Postgrex.query!(
        ctx.connection,
        "select status from sync_external_operations where external_operation_id = $1",
        [UUID.dump!(id)]
      )

    assert status != "pending"
  end

  defp extend(identity, seconds) do
    {:ok, operation} =
      Operation.new(UUID.generate(), :extend_episode, %{"extensionSeconds" => seconds})

    Postgres.begin_operation(identity, operation)
  end

  defp deadline_event(ctx) do
    %{rows: [[payload, operation_id]]} =
      Postgrex.query!(
        ctx.connection,
        "select payload, external_operation_id from sync_control_events where tenant_id = $1 and event_name = 'deadline_changed' order by revision desc limit 1",
        [UUID.dump!(ctx.fixture.episode.tenant_id)]
      )

    %{payload: payload, external_operation_id: UUID.load!(operation_id)}
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
