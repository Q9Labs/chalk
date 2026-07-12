defmodule ChalkSync.Transport.MultiNodeProcessTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ExternalSyncNode
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)

      Application.put_env(:chalk_sync, :stateholder, Postgres)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    fixture = SyncPostgres.seed_session(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    {:ok, fixture: fixture}
  end

  test "two independent unclustered BEAM processes share one order and recover after node death",
       %{
         fixture: fixture,
         connections: connections
       } do
    app_dir = Path.expand("../../..", __DIR__)
    first_port = unused_port()
    second_port = unused_port()

    first =
      start_supervised!(
        {ExternalSyncNode,
         app_dir: app_dir,
         database_url: @database_url,
         port: first_port,
         node_id: "independent-node-a"}
      )

    second =
      start_supervised!(
        {ExternalSyncNode,
         app_dir: app_dir,
         database_url: @database_url,
         port: second_port,
         node_id: "independent-node-b"}
      )

    assert_node_ready(first)
    assert_node_ready(second)

    [first_identity, second_identity] = fixture.identities
    {first_client, first_welcome} = connect_live(first_port, first_identity)
    {second_client, second_welcome} = connect_live(second_port, second_identity)
    assert first_welcome["head"]["revision"] == 2
    assert second_welcome["head"] == first_welcome["head"]

    first_client = Client.send_json(first_client, command("node-a-raise-0001", "raise_hand"))
    second_client = Client.send_json(second_client, command("node-b-raise-0001", "raise_hand"))

    {first_frames, first_client} =
      collect_command_and_revisions(first_client, "node-a-raise-0001", [3, 4])

    {second_frames, second_client} =
      collect_command_and_revisions(second_client, "node-b-raise-0001", [3, 4])

    assert committed_revision(first_frames, "node-a-raise-0001") in [3, 4]
    assert committed_revision(second_frames, "node-b-raise-0001") in [3, 4]

    assert :ok = ExternalSyncNode.stop(first)
    assert_closed(first_client)

    second_client =
      Client.send_json(second_client, command("node-b-lower-0001", "lower_hand"))

    {after_failure, _second_client} =
      collect_command_and_revisions(second_client, "node-b-lower-0001", [5])

    assert committed_revision(after_failure, "node-b-lower-0001") == 5

    restarted =
      start_supervised!(
        {ExternalSyncNode,
         app_dir: app_dir,
         database_url: @database_url,
         port: first_port,
         node_id: "independent-node-a-restarted"}
      )

    assert_node_ready(restarted)
    {_reconnected, restarted_welcome} = connect_live(first_port, first_identity)
    assert restarted_welcome["head"]["revision"] == 5

    assert {:ok, authoritative} = Postgres.recover(first_identity, nil)
    assert authoritative.head.revision == 5

    participants =
      Map.new(authoritative.snapshot["participants"], fn participant ->
        {participant["participant_session_id"], participant["hand_raised"]}
      end)

    assert participants[first_identity.participant_session_id]
    refute participants[second_identity.participant_session_id]

    assert independent_fold(connections, fixture) == authoritative.snapshot
    assert receipt_count(connections, fixture) == 3
    assert :ok = ExternalSyncNode.stop(second)
    assert :ok = ExternalSyncNode.stop(restarted)
  end

  defp connect_live(port, identity) do
    {:ok, client} = Client.connect(port, "/v2/sync")
    client = Client.send_json(client, hello(identity))
    {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client, 5_000)
    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client, 5_000)
    {client, welcome}
  end

  defp collect_command_and_revisions(client, command_id, expected_revisions) do
    collect_command_and_revisions(client, command_id, expected_revisions, nil, [], 12)
  end

  defp collect_command_and_revisions(client, _command_id, [], ack, frames, _remaining)
       when not is_nil(ack),
       do: {Enum.reverse(frames), client}

  defp collect_command_and_revisions(_client, command_id, revisions, ack, frames, 0) do
    flunk(
      "missing command frames command_id=#{command_id} revisions=#{inspect(revisions)} ack=#{inspect(ack)} frames=#{inspect(Enum.reverse(frames))}"
    )
  end

  defp collect_command_and_revisions(client, command_id, revisions, ack, frames, remaining) do
    {:json, frame, client} = Client.recv(client, 5_000)

    {revisions, ack} =
      case frame do
        %{"type" => "ack", "command_id" => ^command_id, "result" => result}
        when result in ["committed", "duplicate"] ->
          {revisions, frame}

        %{"type" => "event", "revision" => revision} ->
          {List.delete(revisions, revision), ack}

        _other ->
          {revisions, ack}
      end

    collect_command_and_revisions(
      client,
      command_id,
      revisions,
      ack,
      [frame | frames],
      remaining - 1
    )
  end

  defp committed_revision(frames, command_id) do
    frames
    |> Enum.find(&(&1["type"] == "ack" and &1["command_id"] == command_id))
    |> Map.fetch!("revision")
  end

  defp independent_fold(connections, fixture) do
    events =
      Postgrex.query!(
        hd(connections),
        """
        select event_name, base_revision, revision, payload
        from sync_control_events
        where tenant_id = $1 and room_id = $2 and session_id = $3
        order by revision
        """,
        session_params(fixture)
      ).rows

    state =
      Enum.reduce(events, Reducer.new(fixture.session.session_id), fn
        [name, base_revision, revision, payload], state ->
          assert {:ok, next} =
                   Reducer.apply_event(state, %{
                     "name" => name,
                     "base_revision" => base_revision,
                     "revision" => revision,
                     "payload" => payload
                   })

          next
      end)

    Reducer.snapshot(state)
  end

  defp receipt_count(connections, fixture) do
    [[count]] =
      Postgrex.query!(
        hd(connections),
        """
        select count(*)
        from sync_command_receipts
        where tenant_id = $1 and session_id = $2
        """,
        [UUID.dump!(fixture.session.tenant_id), UUID.dump!(fixture.session.session_id)]
      ).rows

    count
  end

  defp assert_node_ready(node) do
    case ExternalSyncNode.await_ready(node) do
      {:ok, %{"event" => "sync_node_ready", "os_pid" => os_pid}} ->
        on_exit(fn -> terminate_pid(os_pid) end)
        :ok

      {:error, reason} ->
        flunk("external sync node failed: #{inspect(reason)}")
    end
  end

  defp assert_closed(client) do
    case Client.recv(client, 5_000) do
      {:closed, _code, _reason, _client} -> :ok
      other -> flunk("expected dead node socket to close, got: #{inspect(other)}")
    end
  end

  defp hello(identity) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.session.tenant_id,
        "room_id" => identity.session.room_id,
        "session_id" => identity.session.session_id,
        "participant_id" => identity.participant_session_id,
        "participant_session_id" => identity.participant_session_id,
        "participant_session_generation" => identity.participant_session_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 2,
      "token" => token,
      "streams" => %{"control" => %{"cursor" => nil}}
    }
  end

  defp command(id, name),
    do: %{"type" => "command", "command_id" => id, "name" => name, "payload" => %{}}

  defp session_params(fixture),
    do: [
      UUID.dump!(fixture.session.tenant_id),
      UUID.dump!(fixture.session.room_id),
      UUID.dump!(fixture.session.session_id)
    ]

  defp unused_port do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, {_address, port}} = :inet.sockname(listener)
    :ok = :gen_tcp.close(listener)
    port
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end

  defp terminate_pid(os_pid) do
    System.cmd("kill", ["-TERM", to_string(os_pid)], stderr_to_stdout: true)
    :ok
  rescue
    _exception -> :ok
  end
end
