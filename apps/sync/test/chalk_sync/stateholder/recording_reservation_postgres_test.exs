defmodule ChalkSync.Stateholder.RecordingReservationPostgresTest do
  @moduledoc """
  A Recording reserves the time left on the call, never more than four hours. Extending the call
  moves the reservation in the same transaction, including one made before this behavior shipped,
  so the Recording follows the call. The reservation never moves earlier and never passes four
  hours from its start.
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
  @four_hours_s 14_400

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

  # A one-hour call that may grow to eight hours.
  setup %{connection: connection} do
    now_ms = System.os_time(:millisecond)

    fixture =
      SyncPostgres.seed_episode(
        connection,
        1,
        %{
          default_episode_duration_seconds: 3_600,
          maximum_episode_duration_seconds: 28_800,
          deadline_at_ms: now_ms + @hour_ms,
          deadline_generation: 2
        },
        %{}
      )

    Postgrex.query!(
      connection,
      "update episodes set created_at = to_timestamp($2::double precision / 1000.0), deadline_at = to_timestamp($3::double precision / 1000.0), deadline_generation = 2 where id = $1",
      [UUID.dump!(fixture.episode.episode_id), now_ms, now_ms + @hour_ms]
    )

    on_exit(fn ->
      Postgrex.query!(connection, "delete from recording_reservations where tenant_id = $1", [
        UUID.dump!(fixture.episode.tenant_id)
      ])

      Postgrex.query!(connection, "delete from recordings where tenant_id = $1", [
        UUID.dump!(fixture.episode.tenant_id)
      ])

      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    {:ok, fixture: fixture, now_ms: now_ms}
  end

  test "the reservation covers the time left on the call, not its ceiling", ctx do
    [host] = ctx.fixture.identities
    seconds = start_recording(host, ctx)["max_duration_seconds"]

    assert seconds > 3_600 - 120 and seconds <= 3_600
  end

  test "the reservation never passes four hours", ctx do
    [host] = ctx.fixture.identities
    assert {:ok, %{result: :applied}} = extend(host, 7 * 3_600)

    assert start_recording(host, ctx)["max_duration_seconds"] == @four_hours_s
  end

  test "an extension moves a reservation made before it, in the same transaction", ctx do
    [host] = ctx.fixture.identities
    reservation = insert_reservation(ctx, @hour_ms)

    assert {:ok, %{result: :applied}} = extend(host, 1_800)

    assert reservation_ends_ms(ctx, reservation) == ctx.now_ms + @hour_ms + 1_800_000
    assert reservation_seconds(ctx, reservation) > 5_400 - 120
  end

  test "an extension never moves a reservation earlier or past four hours", ctx do
    [host] = ctx.fixture.identities
    later = insert_reservation(ctx, div(7 * @hour_ms, 2))

    assert {:ok, %{result: :applied}} = extend(host, 1_800)
    assert reservation_ends_ms(ctx, later) == ctx.now_ms + div(7 * @hour_ms, 2)

    capped = insert_reservation(ctx, @hour_ms)
    assert {:ok, %{result: :applied}} = extend(host, 7 * 3_600)

    assert reservation_ends_ms(ctx, capped) <= ctx.now_ms + @four_hours_s * 1_000
    assert reservation_seconds(ctx, capped) <= @four_hours_s
  end

  test "a start accepted before an extension follows it once its reservation exists", ctx do
    [host] = ctx.fixture.identities

    {:ok, start} =
      Operation.new("reservation_start_02", :start_recording, %{"recordingId" => UUID.generate()})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(host, start)

    assert {:ok, %{result: :applied}} = extend(host, 1_800)
    reservation = insert_reservation(ctx, @hour_ms)
    assert reservation_ends_ms(ctx, reservation) == ctx.now_ms + @hour_ms

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(ctx.fixture.episode, id, {:confirmed, :recording})

    assert reservation_ends_ms(ctx, reservation) == ctx.now_ms + @hour_ms + 1_800_000
  end

  defp extend(identity, seconds) do
    {:ok, operation} =
      Operation.new(UUID.generate(), :extend_episode, %{"extensionSeconds" => seconds})

    Postgres.begin_operation(identity, operation)
  end

  defp start_recording(host, ctx) do
    {:ok, start} =
      Operation.new("reservation_start_01", :start_recording, %{"recordingId" => UUID.generate()})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(host, start)

    assert {:ok, stored} = Postgres.read_operation(ctx.fixture.episode, id)
    stored.payload["recording_reservation"]
  end

  # A reservation as an older Sync node and the API wrote it: the Episode's first deadline.
  defp insert_reservation(ctx, ends_in_ms) do
    id = UUID.generate()
    recording_id = UUID.generate()
    episode = ctx.fixture.episode

    keys = [
      UUID.dump!(episode.tenant_id),
      UUID.dump!(episode.space_id),
      UUID.dump!(episode.episode_id)
    ]

    Postgrex.query!(
      ctx.connection,
      "insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider) values ($1, $2, $3, $4, 'pending', 's3')",
      [UUID.dump!(recording_id) | keys]
    )

    Postgrex.query!(
      ctx.connection,
      """
      insert into recording_reservations
        (id, tenant_id, space_id, episode_id, recording_id, idempotency_key, request_fingerprint,
         policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
         starts_at, ends_at)
      values ($1, $2, $3, $4, $5, $6, decode(repeat('00', 32), 'hex'), 'episode_config.v2', 1, $7, 1000, 'reserved',
              to_timestamp($8::double precision / 1000.0), to_timestamp($9::double precision / 1000.0))
      """,
      [UUID.dump!(id)] ++
        keys ++
        [
          UUID.dump!(recording_id),
          "reservation-" <> id,
          div(ends_in_ms, 1_000),
          ctx.now_ms,
          ctx.now_ms + ends_in_ms
        ]
    )

    id
  end

  defp reservation_ends_ms(ctx, id) do
    %{rows: [[ms]]} =
      Postgrex.query!(
        ctx.connection,
        "select (extract(epoch from ends_at) * 1000)::bigint from recording_reservations where id = $1",
        [UUID.dump!(id)]
      )

    ms
  end

  defp reservation_seconds(ctx, id) do
    %{rows: [[seconds]]} =
      Postgrex.query!(
        ctx.connection,
        "select max_duration_seconds from recording_reservations where id = $1",
        [UUID.dump!(id)]
      )

    seconds
  end
end
