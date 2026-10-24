defmodule ChalkSync.LegacyEntryPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  @hello_fixture Path.expand("../fixtures/published-entry-hellos.json", __DIR__)
  @external_resource @hello_fixture

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
    connections = SyncPostgres.start_connections(@database_url)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    Application.put_env(:chalk_sync, :stateholder, Postgres)

    on_exit(fn ->
      Application.put_env(:chalk_sync, :stateholder, stateholder)

      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  for capture <- JSON.decode!(File.read!(@hello_fixture)), mode <- [:pending, :active, :seated] do
    @capture capture
    @mode mode
    @tag :published_legacy_entry
    test "published #{@capture["version"]} entry, reconnect, retry and Leave with #{@mode} storage",
         %{connection: connection, port: port} do
      fixture = SyncPostgres.seed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      prepare_storage(connection, fixture, @mode)

      for {frame, expected} <- Enum.with_index(["hello", "reconnect_hello", "retry_hello"], 1) do
        client = connect_published(port, @capture, frame, fixture.identity)
        assert_generation(connection, fixture.identity, expected)

        if expected == 3 do
          older = %{fixture.identity | entry_generation: 1}
          assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(older)
          assert_generation(connection, fixture.identity, 3)
          leave_on_wire(connection, fixture.identity, client)
        else
          Client.close_tcp(client)
        end
      end
    end
  end

  test "expand release keeps hello admission compatible even when ownership is requested", %{
    connection: connection,
    port: port
  } do
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    Postgrex.query!(
      connection,
      "update sync_entry_rollout set enforced=false,enforced_at=null,release_id=null",
      []
    )

    try do
      capture = JSON.decode!(File.read!(@hello_fixture)) |> hd()
      capture = Map.put(capture, "path", "/v1/sync?entry_confirmation=1&entry_generation=new")
      connect_published(port, capture, "hello", fixture.identity)
      assert_generation(connection, fixture.identity, 0)
    after
      Postgrex.query!(
        connection,
        "update sync_entry_rollout set enforced=true,enforced_at=now(),release_id='test'",
        []
      )
    end
  end

  @tag :published_legacy_entry
  test "modern entry also allocates ownership for an owner created before seat storage", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, identity} = Postgres.admit_entry(fixture.identity, :new)
    assert identity.entry_generation == 1
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(identity)
    assert_generation(connection, identity, 1)
  end

  @tag :published_legacy_entry
  test "a mismatched stored seat cannot admit an identity without ownership", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    prepare_storage(connection, fixture, :seated)

    Postgrex.query!(
      connection,
      "update participant_join_seats set generation=2 where participant_id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    )

    assert {:error, :invalid_admission_intent} = Postgres.admit_entry(fixture.identity, :new)
  end

  defp prepare_storage(_connection, _fixture, :pending), do: :ok

  defp prepare_storage(_connection, fixture, :active) do
    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)
  end

  defp prepare_storage(connection, fixture, :seated) do
    Postgrex.query!(
      connection,
      """
      insert into participant_join_seats
        (tenant_id,space_id,episode_id,participant_id,generation,state,expires_at)
      values ($1,$2,$3,$4,1,'pending',now()+interval '2 minutes')
      """,
      Scope.participant(fixture.identity)
    )
  end

  defp connect_published(port, capture, frame, identity) do
    {:ok, client} = Client.connect(port, capture["path"])
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, Map.put(capture[frame], "token", token(identity)))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    refute Map.has_key?(welcome, "entry_generation")
    refute Map.has_key?(welcome, "entry_confirmation")
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
    client
  end

  defp token(identity) do
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
      "role" => identity.role,
      "capabilities" => identity.capabilities,
      "issued_at" => 1,
      "expires_at" => 4_102_444_800
    })
  end

  defp assert_generation(connection, identity, expected) do
    assert [["active", "joined", ^expected, ^expected]] =
             Postgrex.query!(
               connection,
               """
               select p.status,s.state,s.issued_entry_generation,s.confirmed_entry_generation
               from participants p join participant_join_seats s on s.participant_id=p.id
               where p.id=$1
               """,
               [UUID.dump!(identity.participant_id)]
             ).rows
  end

  defp leave_on_wire(connection, identity, client) do
    command_id = UUID.generate()

    frame = %{
      "type" => "operation",
      "command_id" => command_id,
      "name" => "participant_leave",
      "payload" => %{}
    }

    client = Client.send_json(client, frame)

    assert {%{"type" => "retryable_error", "code" => "external_operation_pending"}, client} =
             receive_response(client, command_id)

    client = Client.send_json(client, frame)

    assert {%{"type" => "retryable_error", "code" => "external_operation_pending"}, _client} =
             receive_response(client, command_id)

    assert [[operation_id, "3"]] =
             Postgrex.query!(
               connection,
               """
               select operation.external_operation_id,operation.payload->>'entryGeneration'
               from sync_external_operations operation
               join sync_command_receipts receipt using(external_operation_id)
               where receipt.tenant_id=$1 and receipt.command_id=$2
               """,
               [UUID.dump!(identity.episode.tenant_id), command_id]
             ).rows

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               identity.episode,
               UUID.load!(operation_id),
               {:confirmed, :provider}
             )

    assert [["left", "left"]] =
             Postgrex.query!(
               connection,
               "select p.status,s.state from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1",
               [UUID.dump!(identity.participant_id)]
             ).rows
  end

  defp receive_response(client, command_id, remaining \\ 12)

  defp receive_response(client, command_id, remaining) when remaining > 0 do
    case Client.recv(client) do
      {:json, %{"command_id" => ^command_id} = response, client} -> {response, client}
      {:json, _frame, client} -> receive_response(client, command_id, remaining - 1)
      other -> flunk("expected operation acknowledgement, got #{inspect(other)}")
    end
  end
end
