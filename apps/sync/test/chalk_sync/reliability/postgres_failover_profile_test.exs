defmodule ChalkSync.Reliability.PostgresFailoverProfileTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalSyncNode
  alias ChalkSync.Reliability.TcpFaultProxy
  alias ChalkSync.Reliability.Wire
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client

  @moduletag :reliability_topology
  @moduletag timeout: 120_000
  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")
  @standby_port System.get_env("CHALK_SYNC_TOPOLOGY_STANDBY_PORT")
  @control Path.expand("../../../scripts/postgres-failover-control", __DIR__)

  setup_all do
    if is_nil(@database_url) or is_nil(@standby_port) do
      raise "failover profile requires the replicated PostgreSQL topology wrapper"
    end

    {standby_port, ""} = Integer.parse(@standby_port || "")
    {:ok, standby_port: standby_port}
  end

  test "stable receipts and recovery survive primary loss and standby promotion", %{
    standby_port: standby_port
  } do
    [seed_connection] = SyncPostgres.start_connections(@database_url, 1)
    fixture = SyncPostgres.seed_episode(seed_connection, 2)
    [identity_a, identity_b] = fixture.identities
    initial_revision = fixture.state.revision
    stop_connection(seed_connection)

    database_proxy =
      start_supervised!({TcpFaultProxy, upstream_port: URI.parse(@database_url).port})

    proxy_database_url =
      Wire.database_url_with_port(@database_url, TcpFaultProxy.port(database_proxy))

    {node_a, port_a} = start_node("failover-a", proxy_database_url)
    {_node_b, port_b} = start_node("failover-b", proxy_database_url)
    {client_a, _welcome_a} = Wire.connect_v1(port_a, identity_a)
    {client_b, _welcome_b} = Wire.connect_v1(port_b, identity_b)

    {_client_a, committed} = Wire.commit_hand(client_a, "failover-hand-0001", true)
    assert committed["ack"]["outcome"] == "committed"
    {_client_b, observed} = Wire.receive_json_type(client_b, "event")
    assert observed["revision"] == initial_revision + 1

    run_control!("failover")
    assert :ok = TcpFaultProxy.switch_upstream(database_proxy, {127, 0, 0, 1}, standby_port)

    {client_a, _welcome} = await_reconnect(node_a, port_a, identity_a, 100)

    {client_a, duplicate} =
      await_duplicate(client_a, "failover-hand-0001", true, 40)

    assert duplicate["outcome"] == "committed"
    assert duplicate["delivery"] == "duplicate"
    assert duplicate["revision"] == initial_revision + 1

    {_node_c, port_c} = start_node("failover-c", proxy_database_url)
    {_recovered, welcome} = Wire.connect_v1(port_c, identity_a)
    assert welcome["head"]["revision"] == initial_revision + 1
    Client.close(client_a)

    cleanup_after_failover(fixture.episode, proxy_database_url)
    write_result()
  end

  defp await_duplicate(_client, command_id, _raised, 0) do
    flunk("Sync nodes did not recover PostgreSQL access for #{command_id}")
  end

  defp await_duplicate(client, command_id, raised, attempts) do
    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => command_id,
        "name" => "set_hand_raised",
        "payload" => %{"raised" => raised}
      })

    case Client.recv(client, 1_000) do
      {:json, %{"type" => "ack", "command_id" => ^command_id} = ack, client} ->
        {client, ack}

      {:json, %{"type" => "retryable_error"}, client} ->
        Process.sleep(100)
        await_duplicate(client, command_id, raised, attempts - 1)

      {:json, _other, client} ->
        await_duplicate(client, command_id, raised, attempts - 1)

      {:error, :timeout} ->
        Process.sleep(100)
        await_duplicate(client, command_id, raised, attempts - 1)

      {:closed, code, reason, _client} ->
        flunk("Sync socket closed during PostgreSQL failover: #{code} #{reason}")
    end
  end

  defp await_reconnect(node, _port, _identity, 0) do
    logs = node |> ExternalSyncNode.logs() |> Enum.take(-40) |> Enum.join("\n")

    flunk("""
    Sync node did not accept a recovered connection after PostgreSQL failover.
    Recent node output:
    #{logs}
    """)
  end

  defp await_reconnect(node, port, identity, attempts) do
    Wire.connect_v1(port, identity)
  rescue
    _exception ->
      Process.sleep(100)
      await_reconnect(node, port, identity, attempts - 1)
  catch
    :exit, _reason ->
      Process.sleep(100)
      await_reconnect(node, port, identity, attempts - 1)
  end

  defp start_node(node_id, database_url) do
    port = Wire.available_port()

    node =
      start_supervised!(
        {ExternalSyncNode,
         app_dir: Path.expand("../../..", __DIR__),
         database_url: database_url,
         node_id: node_id,
         port: port}
      )

    assert {:ok, %{"node_id" => ^node_id, "port" => ^port}} =
             ExternalSyncNode.await_ready(node)

    {node, port}
  end

  defp run_control!(action) do
    case System.cmd(@control, [action], stderr_to_stdout: true) do
      {_output, 0} -> :ok
      {output, status} -> flunk("PostgreSQL #{action} failed (#{status}): #{output}")
    end
  end

  defp cleanup_after_failover(episode, database_url) do
    [connection] = SyncPostgres.start_connections(database_url, 1)
    SyncPostgres.cleanup(connection, episode)
    stop_connection(connection)
  end

  defp write_result do
    if run_directory = System.get_env("CHALK_SYNC_RELIABILITY_RUN_DIR") do
      payload = %{
        "invariants" => %{
          "primary_loss_observed" => true,
          "standby_promoted" => true,
          "stable_receipt_preserved" => true,
          "fresh_node_recovered_authoritative_state" => true
        },
        "verdict" => "pass"
      }

      File.write!(
        Path.join(run_directory, "postgres-failover-result.json"),
        JSON.encode!(payload) <> "\n"
      )
    end
  end

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
