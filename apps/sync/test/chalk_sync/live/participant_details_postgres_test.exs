defmodule ChalkSync.Live.ParticipantDetailsPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  setup_all do
    connections = SyncPostgres.start_connections(@database_url, 4)

    previous =
      for key <- [:stateholder, :database_connections],
          into: %{},
          do: {key, Application.get_env(:chalk_sync, key)}

    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      for {key, value} <- previous do
        if value,
          do: Application.put_env(:chalk_sync, key, value),
          else: Application.delete_env(:chalk_sync, key)
      end

      for pid <- connections, do: TestProcess.stop(pid)
    end)

    {:ok, connection: hd(connections)}
  end

  test "participant identity details are opt-in wire metadata", %{
    connection: connection,
    port: port
  } do
    fixture = SyncPostgres.seed_episode(connection, 1)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host] = fixture.identities
    identity_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into identities (id, tenant_id, kind, external_id, display_name)
      values ($1, $2, 'agent', 'live-participant-details-agent', 'Agent Participant')
      """,
      [UUID.dump!(identity_id), UUID.dump!(fixture.episode.tenant_id)]
    )

    Postgrex.query!(
      connection,
      "update participants set identity_id=$2, description='AI teammate' where tenant_id=$1 and id=$3",
      [
        UUID.dump!(fixture.episode.tenant_id),
        UUID.dump!(identity_id),
        UUID.dump!(host.participant_id)
      ]
    )

    {detailed_welcome, detailed} = session(port, "/v1/sync?participant_details=1", host)
    assert detailed_welcome["participant_details"] == true
    assert participant_kind(detailed_welcome, host) == "agent"
    assert participant(detailed_welcome, host)["description"] == "AI teammate"
    Client.close_tcp(detailed)

    {legacy_welcome, legacy} = session(port, "/v1/sync", host)
    refute Map.has_key?(legacy_welcome, "participant_details")
    refute participant(legacy_welcome, host)["identity_kind"]
    refute participant(legacy_welcome, host)["description"]
    Client.close_tcp(legacy)
  end

  defp session(port, path, identity) do
    {:ok, client} = Client.connect(port, path)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(identity),
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })

    assert {:json, %{"type" => "welcome", "mode" => "snapshot"} = welcome, client} =
             Client.recv(client)

    {welcome, client}
  end

  defp participant(welcome, identity) do
    Enum.find(
      welcome["snapshot"]["participants"],
      &(&1["participant_id"] == identity.participant_id)
    )
  end

  defp participant_kind(welcome, identity), do: participant(welcome, identity)["identity_kind"]

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
end
