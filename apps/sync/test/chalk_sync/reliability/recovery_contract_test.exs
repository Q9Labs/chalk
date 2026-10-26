defmodule ChalkSync.Reliability.RecoveryContractTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalSyncNode
  alias ChalkSync.Reliability.Wire
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")
  @target "recovery-target-0001"
  @anchor "recovery-anchor-0001"
  @command_boundaries [
    :before_transaction,
    :after_event_insert,
    :after_control_update,
    :after_receipt_insert,
    :after_commit_before_reply,
    :after_ack
  ]

  setup_all do
    if is_nil(@database_url), do: raise("recovery contract requires real PostgreSQL")
    connections = SyncPostgres.start_connections(@database_url)
    previous = Application.get_env(:chalk_sync, :database_connections)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  @tag timeout: 180_000
  test "commands survive every crash boundary", %{connection: connection} do
    Enum.each(@command_boundaries, &prove_command_recovery(connection, &1))
  end

  defp prove_command_recovery(connection, boundary) do
    fixture = SyncPostgres.seed_pending_join(connection)
    fixture = SyncPostgres.seed_webhook_endpoint(fixture, connection, ["participant.joined"])
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {listener, barrier_port} = barrier()
    {node, port} = start_node(boundary, @target, barrier_port)
    {client, _welcome} = Wire.connect_v1(port, fixture.identity)
    {client, anchor} = Wire.commit_hand(client, @anchor, true)
    client = Wire.acknowledge_control_event(client, anchor["event"])
    cursor = cursor(anchor["ack"])
    before = durable_rows(connection, fixture.episode)

    client = Wire.send_hand(client, @target, false)

    acknowledged =
      if boundary == :after_ack do
        assert {:ok, _client, ack} = Wire.receive_command_ack(client, @target)
        ack
      else
        await_boundary(listener, boundary, @target, node)
        nil
      end

    committed = boundary in [:after_commit_before_reply, :after_ack]

    assert command_counts(connection, fixture.episode) ==
             if(committed, do: [1, 1], else: [0, 0])

    assert :ok = ExternalSyncNode.kill(node)
    Client.close_tcp(client)

    {restarted, port} = start_node(:none, @target, barrier_port)
    {client, welcome} = Wire.connect_v1(port, fixture.identity)
    expected_revision = anchor["ack"]["revision"] + if(committed, do: 1, else: 0)
    assert welcome["head"]["revision"] == expected_revision
    assert welcome["snapshot"]["control_revision"] == expected_revision
    assert [participant] = welcome["snapshot"]["participants"]
    assert participant["participant_id"] == fixture.identity.participant_id
    assert participant["hand_raised"] == not committed
    assert welcome["snapshot"]["state_digest"] == welcome["head"]["state_digest"]
    unless committed, do: assert(welcome["head"]["state_digest"] == anchor["ack"]["state_digest"])

    # A second command, acknowledged before every crash, must never disappear.
    client = Wire.send_hand(client, @anchor, true)
    assert {:ok, client, duplicate_anchor} = Wire.receive_command_ack(client, @anchor)
    assert stable_ack(duplicate_anchor) == stable_ack(anchor["ack"])
    assert duplicate_anchor["delivery"] == "duplicate"

    client = Wire.send_hand(client, @target, false)
    assert {:ok, client, target_ack} = Wire.receive_command_ack(client, @target)
    assert target_ack["outcome"] == "committed"
    assert target_ack["revision"] == anchor["ack"]["revision"] + 1
    assert target_ack["delivery"] == if(committed, do: "duplicate", else: "original")
    if acknowledged, do: assert(stable_ack(target_ack) == stable_ack(acknowledged))
    Client.close_tcp(client)

    # Validate the actual replay payload, not just a recovered head hint.
    assert_replay(port, fixture.identity, cursor, target_ack)
    assert command_counts(connection, fixture.episode) == [1, 1]
    assert_lifecycle_once(connection, fixture, "participant_joined", "participant.joined")

    after_recovery = durable_rows(connection, fixture.episode)
    assert Enum.all?(before, fn {table, rows} -> rows -- after_recovery[table] == [] end)

    assert :ok = ExternalSyncNode.kill(restarted)
  end

  for lifecycle <- [:join, :leave, :end],
      boundary <- [
        :after_event_insert,
        :after_intent_applied,
        :after_webhook_production,
        :after_commit_before_reply
      ] do
    @lifecycle lifecycle
    @boundary boundary
    test "#{lifecycle} and its webhook recover once at #{boundary}", %{connection: connection} do
      {fixture, intent_id, event_name, webhook_name} = lifecycle_fixture(connection, @lifecycle)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      {listener, barrier_port} = barrier()
      {node, port} = start_node(@boundary, intent_id, barrier_port)

      # Admission is confirmed by hello; leave/end are consumed from API intents.
      if @lifecycle == :join do
        {:ok, client} = Client.connect(port, "/v1/sync")
        send_hello(client, fixture.identity, nil)
      end

      await_boundary(listener, @boundary, intent_id, node)
      assert :ok = ExternalSyncNode.kill(node)
      {restarted, port} = start_node(:none, intent_id, barrier_port)

      if @lifecycle == :join do
        {client, _welcome} = Wire.connect_v1(port, fixture.identity)
        Client.close_tcp(client)
      end

      await_applied(connection, fixture.episode, intent_id, 100)
      assert_lifecycle_once(connection, fixture, event_name, webhook_name)
      before = durable_rows(connection, fixture.episode)

      assert {:ok, %{result: :already_applied}} =
               Postgres.apply_lifecycle_intent(fixture.episode, intent_id)

      assert durable_rows(connection, fixture.episode) == before
      assert :ok = ExternalSyncNode.kill(restarted)
    end
  end

  defp barrier do
    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, packet: :line, ip: {127, 0, 0, 1}])

    {:ok, {_address, port}} = :inet.sockname(listener)
    on_exit(fn -> :gen_tcp.close(listener) end)
    {listener, port}
  end

  defp await_boundary(listener, boundary, target, node) do
    result = :gen_tcp.accept(listener, 10_000)
    assert {:ok, socket} = result, Enum.join(ExternalSyncNode.logs(node), "\n")
    assert {:ok, message} = :gen_tcp.recv(socket, 0, 5_000)
    assert JSON.decode!(message) == %{"boundary" => Atom.to_string(boundary), "target" => target}
    on_exit(fn -> :gen_tcp.close(socket) end)
  end

  defp start_node(boundary, target, barrier_port) do
    node_id = "recovery-#{System.unique_integer([:positive])}"
    port = Wire.available_port()

    node =
      start_supervised!(
        {ExternalSyncNode,
         app_dir: Path.expand("../../..", __DIR__),
         database_url: @database_url,
         node_id: node_id,
         port: port,
         script: "test/support/reliability/recovery_node.exs",
         env: [
           {~c"CHALK_RECOVERY_BARRIER_PORT", to_charlist(Integer.to_string(barrier_port))},
           {~c"CHALK_RECOVERY_TARGET", to_charlist(target)},
           {~c"CHALK_RECOVERY_BOUNDARY", to_charlist(boundary)}
         ]}
      )

    assert {:ok, %{"os_pid" => os_pid}} = ExternalSyncNode.await_ready(node)
    assert os_pid != System.pid()
    {node, port}
  end

  defp stable_ack(ack),
    do: Map.take(ack, ["command_id", "outcome", "reason", "event_id", "revision", "state_digest"])

  defp cursor(ack),
    do: %{
      "revision" => ack["revision"],
      "state_digest" => ack["state_digest"],
      "state_schema_version" => 1
    }

  defp send_hello(client, identity, cursor) do
    Client.send_json(client, %{
      "type" => "hello",
      "protocol" => 1,
      "token" => Wire.token(identity),
      "streams" =>
        Map.new(["control", "media", "presence", "requests"], fn stream ->
          {stream, %{"cursor" => if(stream == "control", do: cursor, else: nil)}}
        end)
    })
  end

  defp assert_replay(port, identity, cursor, ack) do
    {:ok, client} = Client.connect(port, "/v1/sync")
    client = send_hello(client, identity, cursor)
    {client, welcome} = Wire.receive_json_type(client, "welcome")
    assert welcome["mode"] == "replay"
    assert welcome["head"]["revision"] == ack["revision"]
    assert welcome["head"]["state_digest"] == ack["state_digest"]
    {client, page} = Wire.receive_json_type(client, "replay_page")
    assert [event] = page["events"]
    assert event["command_id"] == @target
    assert event["event_id"] == ack["event_id"]
    assert event["revision"] == ack["revision"]
    assert event["resulting_state_digest"] == ack["state_digest"]
    assert event["payload"] == %{"participant_id" => identity.participant_id, "raised" => false}
    client = Client.acknowledge_recovery(client, page)
    {client, _complete} = Wire.receive_json_type(client, "recovery_complete")
    Client.close_tcp(client)
  end

  defp command_counts(connection, episode) do
    Enum.map(["sync_control_events", "sync_command_receipts"], fn table ->
      [[count]] =
        Postgrex.query!(
          connection,
          "select count(*) from #{table} where tenant_id = $1 and episode_id = $2 and command_id = $3",
          [UUID.dump!(episode.tenant_id), UUID.dump!(episode.episode_id), @target]
        ).rows

      count
    end)
  end

  defp lifecycle_fixture(connection, :join) do
    fixture = SyncPostgres.seed_pending_join(connection)
    fixture = SyncPostgres.seed_webhook_endpoint(fixture, connection, ["participant.joined"])
    {fixture, fixture.lifecycle_intent_id, "participant_joined", "participant.joined"}
  end

  defp lifecycle_fixture(connection, kind) do
    fixture = SyncPostgres.seed_episode(connection)
    fixture = Map.put(fixture, :identity, hd(fixture.identities))
    webhook = if kind == :leave, do: "participant.left", else: "episode.ended"
    fixture = SyncPostgres.seed_webhook_endpoint(fixture, connection, [webhook])

    if kind == :leave do
      fixture = SyncPostgres.request_pending_leave(connection, fixture)
      {fixture, fixture.leave_lifecycle_intent_id, "participant_left", webhook}
    else
      fixture = SyncPostgres.request_pending_end(connection, fixture)
      {fixture, fixture.end_lifecycle_intent_id, "episode_ended", webhook}
    end
  end

  defp assert_lifecycle_once(connection, fixture, event_name, webhook_name) do
    params = [
      UUID.dump!(fixture.episode.tenant_id),
      UUID.dump!(fixture.episode.episode_id),
      event_name
    ]

    assert [[1]] =
             Postgrex.query!(
               connection,
               """
               select count(*) from sync_control_events
               where tenant_id = $1 and episode_id = $2 and event_name = $3
               """,
               params
             ).rows

    assert [[1, 1]] =
             Postgrex.query!(
               connection,
               """
               select count(distinct e.id), count(d.id)
               from webhook_events e join webhook_deliveries d
                 on d.tenant_id = e.tenant_id and d.event_id = e.id
               where e.tenant_id = $1 and e.event_name = $2
               """,
               [UUID.dump!(fixture.episode.tenant_id), webhook_name]
             ).rows
  end

  defp durable_rows(connection, episode) do
    Map.new(
      [
        "sync_control_events",
        "sync_command_receipts",
        "sync_lifecycle_intents",
        "webhook_events",
        "webhook_deliveries"
      ],
      fn table ->
        rows =
          Postgrex.query!(
            connection,
            "select to_jsonb(t) from #{table} t where tenant_id = $1 order by to_jsonb(t)::text",
            [UUID.dump!(episode.tenant_id)]
          ).rows

        {table, rows}
      end
    )
  end

  defp await_applied(_connection, _episode, _intent_id, 0),
    do: flunk("lifecycle intent did not recover")

  defp await_applied(connection, episode, intent_id, attempts) do
    rows =
      Postgrex.query!(
        connection,
        "select status from sync_lifecycle_intents where tenant_id = $1 and episode_id = $2 and lifecycle_intent_id = $3",
        [UUID.dump!(episode.tenant_id), UUID.dump!(episode.episode_id), UUID.dump!(intent_id)]
      ).rows

    if rows != [["applied"]] do
      Process.sleep(50)
      await_applied(connection, episode, intent_id, attempts - 1)
    end
  end
end
