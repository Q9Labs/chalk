defmodule ChalkSync.Stateholder.EpisodeEndReasonPostgresTest do
  @moduledoc """
  Every end of an Episode writes the reason it ended, so the history says why a call stopped.
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

  setup %{connection: connection} do
    seed = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, seed.episode) end)
    {:ok, seed: seed}
  end

  test "a linger end stores its own reason and tells clients the v1 recovery reason", ctx do
    assert {:ok, %{result: :applied}} =
             end_episode(ctx.seed.episode, %{"reason" => "linger_expired"}, "tenant_recovery")

    assert stored_reason(ctx) == "linger_expired"
    assert ended_event_reason(ctx) == "tenant_recovery"
  end

  test "a maximum duration end stores and replicates the same reason", ctx do
    assert {:ok, %{result: :applied}} =
             end_episode(ctx.seed.episode, %{"reason" => "maximum_duration"}, "maximum_duration")

    assert stored_reason(ctx) == "maximum_duration"
    assert ended_event_reason(ctx) == "maximum_duration"
  end

  test "an end with no reason is a host end", ctx do
    assert {:ok, %{result: :applied}} = end_episode(ctx.seed.episode, %{}, "tenant_recovery")

    assert stored_reason(ctx) == "tenant_recovery"
    assert ended_event_reason(ctx) == "tenant_recovery"
  end

  test "an end that reports another reason than the request carried is refused", ctx do
    assert {:error, _} =
             end_episode(ctx.seed.episode, %{"reason" => "linger_expired"}, "maximum_duration")

    assert stored_reason(ctx) == nil
  end

  defp end_episode(episode, payload, wire_reason) do
    {:ok, operation} =
      Operation.new("end_reason_" <> UUID.generate(), :tenant_end_episode, payload)

    {:ok, %{external_operation_id: id}} = Postgres.begin_internal_operation(episode, operation)

    Postgres.finalize_operation(
      episode,
      id,
      {:applied, :episode_ended, %{"reason" => wire_reason}}
    )
  end

  defp ended_event_reason(ctx) do
    %{rows: [[payload]]} =
      Postgrex.query!(
        ctx.connection,
        "select payload from sync_control_events where tenant_id = $1 and event_name = 'episode_ended'",
        [UUID.dump!(ctx.seed.episode.tenant_id)]
      )

    payload["reason"]
  end

  defp stored_reason(ctx) do
    %{rows: [[reason]]} =
      Postgrex.query!(
        ctx.connection,
        "select end_reason from episodes where id = $1",
        [UUID.dump!(ctx.seed.episode.episode_id)]
      )

    reason
  end
end
