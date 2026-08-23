defmodule ChalkSync.Stateholder.PostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres

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

  setup %{connections: connections} do
    fixture = SyncPostgres.seed_episode(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.episode) end)
    {:ok, fixture: fixture}
  end

  test "serializes concurrent decisions from independent node connection sets", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_episode(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.episode) end)
    [first_identity, _second_identity] = fixture.identities
    second_identity = first_identity

    first =
      Task.async(fn ->
        Process.put(:sync_test_node, :first)
        Postgres.decide_command(first_identity, command("node_first_cmd01", :raise_hand))
      end)

    second =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)
        Postgres.decide_command(second_identity, command("node_second_cmd1", :raise_hand))
      end)

    decisions = [Task.await(first), Task.await(second)]

    assert Enum.all?(decisions, fn
             {:ok, %{result: result}} when result in [:committed, :satisfied] -> true
             _ -> false
           end)

    assert decisions |> Enum.map(fn {:ok, decision} -> decision.revision end) |> Enum.uniq() == [
             3
           ]

    assert {:ok, recovery} = Postgres.recover(fixture.episode, nil)
    assert recovery.head.revision == 3
    assert Enum.count(recovery.snapshot["participants"], & &1["hand_raised"]) == 1
  end

  defp command(id, name) do
    payload = if name == :raise_hand, do: %{"raised" => true}, else: %{"raised" => false}
    normalized_name = if name in [:raise_hand, :lower_hand], do: :set_hand_raised, else: name
    {:ok, command} = Command.new(String.pad_trailing(id, 16, "_"), normalized_name, payload)
    command
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
