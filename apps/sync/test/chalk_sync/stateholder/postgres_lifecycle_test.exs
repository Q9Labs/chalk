defmodule ChalkSync.Stateholder.PostgresLifecycleTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Database
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
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  @tag :host_exit
  test "webhook failure rolls the product, control Event, operation, Event, and fanout back together",
       %{
         connections: connections
       } do
    test_pid = self()
    handler_id = "postgres-webhook-rollback-metrics-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach_many(
        handler_id,
        [[:chalk, :sync, :webhook, :production], [:chalk, :sync, :webhook, :fanout]],
        fn event, measurements, metadata, _config ->
          send(test_pid, {:webhook_metric, event, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    connection = hd(connections)

    seed = SyncPostgres.seed_episode(connection, 2)

    fixture =
      %{episode: seed.episode, identity: Enum.at(seed.identities, 1)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left"])

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    {:ok, operation} = Operation.new("webhook_rollback_01", :participant_leave, %{})

    assert {:ok, %{result: :pending} = pending} =
             Postgres.begin_operation(fixture.identity, operation)

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, _context ->
      if point == :after_webhook_production, do: raise("injected webhook rollback")
    end)

    try do
      assert {:retryable, :decision_unavailable} =
               Postgres.finalize_operation(
                 fixture.episode,
                 pending.external_operation_id,
                 leave_outcome(fixture.identity)
               )
    after
      Application.delete_env(:chalk_sync, :external_operation_fault_hook)
    end

    assert [["leaving", "pending", 2, 0, 0]] =
             query_rows(
               fixture,
               """
               select p.status, o.status, c.control_revision,
                 (select count(*) from webhook_events e where e.tenant_id = $1),
                 (select count(*) from webhook_deliveries d where d.tenant_id = $1)
               from participants p
               join sync_external_operations o
                 on o.tenant_id = p.tenant_id and o.target_participant_id = p.id
               join sync_episode_control c
                 on c.tenant_id = p.tenant_id and c.episode_id = p.episode_id
               where p.tenant_id = $1 and p.episode_id = $2 and p.id = $3
               """,
               [UUID.dump!(fixture.identity.participant_id)]
             )

    refute_receive {:webhook_metric, _event, _measurements, _metadata}, 50

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               pending.external_operation_id,
               leave_outcome(fixture.identity)
             )

    assert_receive {:webhook_metric, [:chalk, :sync, :webhook, :production], %{count: 1},
                    %{
                      api_version: 1,
                      event_name: "participant.left",
                      outcome: :committed
                    }}

    assert_receive {:webhook_metric, [:chalk, :sync, :webhook, :fanout], %{count: 1},
                    %{api_version: 1, event_name: "participant.left", outcome: :queued}}

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.finalize_operation(
               fixture.episode,
               pending.external_operation_id,
               leave_outcome(fixture.identity)
             )

    refute_receive {:webhook_metric, _event, _measurements, _metadata}, 50
  end

  defp query_rows(fixture, sql, extra_params) do
    params =
      [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.episode_id)] ++
        extra_params

    Database.connection(fixture.episode)
    |> Postgrex.query!(sql, params)
    |> Map.fetch!(:rows)
  end

  defp leave_outcome(identity) do
    {:applied, :participant_left,
     %{
       "participant_id" => identity.participant_id,
       "reason" => "left"
     }}
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection) do
      try do
        GenServer.stop(connection)
      catch
        :exit, {:noproc, _details} -> :ok
        :exit, :noproc -> :ok
      end
    end
  end
end
