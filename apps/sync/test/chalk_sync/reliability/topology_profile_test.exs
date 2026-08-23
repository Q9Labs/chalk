defmodule ChalkSync.Reliability.TopologyProfileTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalSyncNode
  alias ChalkSync.Reliability.TcpFaultProxy
  alias ChalkSync.Reliability.Wire
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client

  @moduletag :reliability_topology
  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if is_nil(@database_url), do: raise("topology profile requires CHALK_SYNC_TEST_DATABASE_URL")

    [connection] = connections = SyncPostgres.start_connections(@database_url, 1)
    on_exit(fn -> Enum.each(connections, &stop_connection/1) end)
    {:ok, connection: connection}
  end

  test "multiple nodes converge across a client partition and unclean node loss", %{
    connection: connection
  } do
    fixture =
      SyncPostgres.seed_episode(connection, 2, %{}, %{
        participants: [%{}, %{role: "collaborator"}]
      })

    [identity_a, identity_b] = fixture.identities
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    {node_a, port_a} = start_node("topology-a")
    {_node_b, port_b} = start_node("topology-b")
    proxy = start_supervised!({TcpFaultProxy, upstream_port: port_a})
    proxy_port = TcpFaultProxy.port(proxy)

    {client_a, welcome_a} = Wire.connect_v1(proxy_port, identity_a)
    {client_b, welcome_b} = Wire.connect_v1(port_b, identity_b)
    initial_revision = welcome_a["head"]["revision"]
    assert welcome_b["head"]["revision"] == initial_revision

    {_client_a, first_frames} = Wire.commit_hand(client_a, "topology-hand-0001", true)
    assert first_frames["ack"]["outcome"] == "committed"
    {client_b, observed} = Wire.receive_json_type(client_b, "event")
    assert observed["command_id"] == "topology-hand-0001"
    client_b = Wire.acknowledge_control_event(client_b, observed)

    assert :ok = TcpFaultProxy.partition(proxy)
    {client_b, second_frames} = Wire.commit_hand(client_b, "topology-hand-0002", true)
    assert second_frames["event"]["revision"] == initial_revision + 2

    assert :ok = TcpFaultProxy.heal(proxy)
    {_reconnected, recovered} = Wire.connect_v1(proxy_port, identity_a)
    assert recovered["head"]["revision"] == initial_revision + 2

    prove_whiteboard_cross_node(port_a, port_b, identity_a, identity_b)

    assert :ok = ExternalSyncNode.kill(node_a)
    client_b = Client.send_json(client_b, %{"type" => "ping"})
    {_client_b, _pong} = Wire.receive_json_type(client_b, "pong")

    assert %{partitions: 1} = TcpFaultProxy.stats(proxy)
    write_result()
  end

  defp start_node(node_id) do
    port = Wire.available_port()

    node =
      start_supervised!(
        {ExternalSyncNode,
         app_dir: Path.expand("../../..", __DIR__),
         database_url: @database_url,
         node_id: node_id,
         port: port}
      )

    assert {:ok, %{"node_id" => ^node_id, "port" => ^port}} =
             ExternalSyncNode.await_ready(node)

    {node, port}
  end

  defp prove_whiteboard_cross_node(port_a, port_b, author_identity, observer_identity) do
    {author, welcome} = connect_whiteboard(port_a, author_identity)
    {observer, _observer_welcome} = connect_whiteboard(port_b, observer_identity)
    scene_id = welcome["scene_id"]

    author =
      Client.send_json(author, %{
        "type" => "submit_update",
        "operation_id" => "topology-whiteboard-update-0001",
        "scene_id" => scene_id,
        "sync_all" => false,
        "elements" => [whiteboard_element()]
      })

    {author, commit} = Wire.receive_json_type(author, "commit")
    assert commit["revision"] == "1"
    {observer, update} = Wire.receive_json_type(observer, "update")
    assert update["revision"] == "1"

    Client.send_json(author, %{"type" => "cursor", "x" => 12, "y" => 24})
    {_observer, cursor} = Wire.receive_json_type(observer, "cursor")
    assert cursor["participant_id"] == author_identity.participant_id
  end

  defp connect_whiteboard(port, identity) do
    {:ok, client} = Client.connect(port, "/v1/whiteboard")

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => "whiteboard-v1",
        "token" => Wire.token(identity),
        "cursor" => nil
      })

    Wire.receive_json_type(client, "welcome")
  end

  defp whiteboard_element do
    %{
      "id" => "topology-element-1",
      "type" => "rectangle",
      "version" => 1,
      "version_nonce" => 1,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{"x" => 1, "y" => 2}
    }
  end

  defp write_result do
    write_evidence("topology-result.json", %{
      "invariants" => %{
        "cross_node_control_convergence" => true,
        "network_partition_recovery" => true,
        "unclean_node_loss_survived" => true,
        "whiteboard_durable_convergence" => true,
        "whiteboard_transient_fanout" => true
      },
      "verdict" => "pass"
    })
  end

  defp write_evidence(name, payload) do
    if run_directory = System.get_env("CHALK_SYNC_RELIABILITY_RUN_DIR") do
      File.write!(Path.join(run_directory, name), JSON.encode!(payload) <> "\n")
    end
  end

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
