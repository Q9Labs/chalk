defmodule ChalkSync.Stateholder.PostgresExternalOperationTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url, 6)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        if previous_connections,
          do: Application.put_env(:chalk_sync, :database_connections, previous_connections),
          else: Application.delete_env(:chalk_sync, :database_connections)

        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    fixture = SyncPostgres.seed_episode(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.episode) end)
    {:ok, fixture: fixture}
  end

  test "two concurrent finalizers append at most one exact-next fact", %{fixture: fixture} do
    [host, guest] = fixture.identities

    operation =
      operation("camera_concurrent1", :stop_participant_camera, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    outcome =
      {:applied, :participant_camera_stopped, %{"participant_id" => guest.participant_id}}

    results =
      1..2
      |> Task.async_stream(
        fn _ -> Postgres.finalize_operation(fixture.episode, operation_id, outcome) end,
        max_concurrency: 2,
        ordered: false
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.all?(results, &match?({:ok, %{result: :applied}}, &1))

    assert [[1, 3, 3]] =
             query_rows(
               fixture,
               """
               select count(*), min(revision), max(revision)
               from sync_control_events
               where tenant_id = $1 and episode_id = $2
                 and external_operation_id = $3
               """,
               [UUID.dump!(operation_id)]
             )
  end

  defp operation(request_key, name, payload) do
    {:ok, operation} = Operation.new(request_key, name, payload)
    operation
  end

  defp query_rows(fixture, sql, extra_params) do
    params =
      [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.episode_id)] ++
        extra_params

    Postgrex.query!(ChalkSync.Database.connection(fixture.episode), sql, params).rows
  end

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
