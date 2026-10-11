defmodule ChalkSync.Stateholder.PostgresWebhookConcurrencyTest do
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
    if @database_url do
      connections = SyncPostgres.start_connections(@database_url, 4)
      on_exit(fn -> Enum.each(connections, &TestProcess.stop/1) end)
      {:ok, connections: connections}
    else
      :ok
    end
  end

  test "different Episodes can commit webhook fanout while another producer is uncommitted", %{
    connections: connections
  } do
    connection = hd(connections)
    tenant_id = UUID.generate()
    first = SyncPostgres.seed_episode(connection, 30, %{}, %{tenant_id: tenant_id})
    second = SyncPostgres.seed_episode(connection, 30, %{}, %{tenant_id: tenant_id})

    SyncPostgres.seed_webhook_endpoint(first, connection, ["episode.ended", "participant.left"])

    previous_connections = Application.get_env(:chalk_sync, :database_connections)
    previous_hook = Application.get_env(:chalk_sync, :external_operation_fault_hook)

    Application.put_env(:chalk_sync, :database_connections, fn episode, _offset ->
      if episode == first.episode, do: Enum.at(connections, 1), else: Enum.at(connections, 2)
    end)

    on_exit(fn ->
      restore_env(:external_operation_fault_hook, previous_hook)
      restore_env(:database_connections, previous_connections)
      SyncPostgres.cleanup(connection, first.episode)
    end)

    first_end = begin_end(first, "webhook_concurrent_first")
    second_end = begin_end(second, "webhook_concurrent_second")
    owner = self()

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, context ->
      if point == :after_webhook_production and context.episode_id == first.episode.episode_id do
        send(owner, {:producer_uncommitted, self()})

        receive do
          :release_producer -> :ok
        after
          2_000 -> raise "producer release was not received"
        end
      end
    end)

    held = Task.async(fn -> finalize(first, first_end) end)
    assert_receive {:producer_uncommitted, producer}, 2_000

    result =
      try do
        finalize(second, second_end)
      after
        send(producer, :release_producer)
      end

    assert {:ok, %{result: :applied}} = Task.await(held, 5_000)
    assert {:ok, %{result: :applied}} = result

    assert [[62, 62]] =
             Postgrex.query!(
               connection,
               """
               select
                 (select count(*) from webhook_events where tenant_id = $1),
                 (select count(*) from webhook_deliveries where tenant_id = $1)
               """,
               [UUID.dump!(tenant_id)]
             ).rows
  end

  defp begin_end(fixture, request_key) do
    {:ok, operation} = Operation.new(request_key, :end_episode, %{})

    {:ok, %{external_operation_id: external_id}} =
      Postgres.begin_operation(hd(fixture.identities), operation)

    external_id
  end

  defp finalize(fixture, external_id),
    do: Postgres.finalize_operation(fixture.episode, external_id, {:confirmed, :provider})

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)
end
