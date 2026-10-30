defmodule ChalkSync.Live.ParticipantDevicesPostgresTest do
  use ChalkSync.ServerCase, async: false
  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Live.Projection
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    connections = SyncPostgres.start_connections(@database_url)

    previous =
      for key <- [:stateholder, :database_connections],
          into: %{},
          do: {key, Application.get_env(:chalk_sync, key)}

    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      for {key, value} <- previous, do: Application.put_env(:chalk_sync, key, value)
      for pid <- connections, do: ChalkSync.TestProcess.stop(pid)
    end)

    {:ok, connection: hd(connections)}
  end

  test "initial and recovery projections include an admitted seat without a socket, until durable leave",
       %{connection: connection, port: port} do
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [desktop, phone] = fixture.identities
    person = associate_person(connection, fixture.episode)

    assert {:ok, desktop} =
             Stateholder.admit_socket_entry(%{desktop | device_type: "computer"}, :legacy)

    assert {:ok, phone} = Stateholder.admit_socket_entry(%{phone | device_type: "phone"}, :legacy)
    assert desktop.identity_id == person
    assert phone.identity_id == person

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(outcomes: %{observe_episode_publications: {:ok, []}})

    previous = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> Application.put_env(:chalk_sync, :media_plane, previous) end)
    # The desktop has no live socket, and a new coordinator has no cached hint.
    assert {:ok, live, frames, _} =
             LiveEpisode.register(LiveEpisode.new(fixture.episode), phone, self())

    presence = Enum.find(frames, &(&1["stream"] == "presence"))
    absent = Enum.find(presence["items"], &(&1["participant_id"] == desktop.participant_id))

    assert %{
             "identity_id" => ^person,
             "device_type" => "computer",
             "state" => "disconnected",
             "admission_revision" => revision
           } = absent

    assert revision > 0

    assert {:ok, recovered, recovery, _} =
             LiveEpisode.register(LiveEpisode.new(fixture.episode), phone, self())

    assert Enum.any?(Enum.find(recovery, &(&1["stream"] == "presence"))["items"], &(&1 == absent))
    # Check the actual negotiated wire for a fresh socket, including an older client.
    for {path, opted_in, admissions} <- [
          {"/v1/sync?participant_devices=1&participant_device_admissions=2", true, true},
          {"/v1/sync?participant_devices=1&participant_device_admissions=1", true, true},
          {"/v1/sync?participant_devices=1", true, false},
          {"/v1/sync", false, false}
        ] do
      {client, items, welcome} = connect_presence(port, path, phone)

      assert welcome["participant_identity_id"] ==
               if(String.contains?(path, "admissions=2"), do: person, else: nil)

      item = Enum.find(items, &(&1["participant_id"] == desktop.participant_id))
      assert item["state"] == "disconnected"

      if opted_in do
        assert item["identity_id"] == person
        assert item["device_type"] == "computer"
      else
        refute Map.has_key?(item, "identity_id")
        refute Map.has_key?(item, "device_type")
        refute Map.has_key?(item, "admission_revision")
      end

      if admissions,
        do: assert(item["admission_revision"] == revision),
        else: refute(Map.has_key?(item, "admission_revision"))

      Client.close_tcp(client)
    end

    # Same participant UUID in a new generation cannot inherit the old device type.
    Postgrex.query!(
      connection,
      "update participant_device_hints set generation=generation+1 where participant_id=$1",
      [UUID.dump!(desktop.participant_id)]
    )

    assert {:ok, refreshed, _} = LiveEpisode.presence_snapshot(recovered)

    assert Enum.find(
             Projection.items(refreshed.presence_projection),
             &(&1["participant_id"] == desktop.participant_id)
           )["device_type"] == nil

    assert {:ok, []} =
             Stateholder.participant_devices(%{fixture.episode | tenant_id: UUID.generate()})

    assert {:ok, []} =
             Stateholder.participant_devices(%{fixture.episode | space_id: UUID.generate()})

    assert {:ok, []} =
             Stateholder.participant_devices(%{fixture.episode | episode_id: UUID.generate()})

    Postgrex.query!(connection, "update participants set status='left' where id=$1", [
      UUID.dump!(desktop.participant_id)
    ])

    assert {:ok, left, _} = LiveEpisode.presence_snapshot(live)

    refute Enum.any?(
             Projection.items(left.presence_projection),
             &(&1["participant_id"] == desktop.participant_id)
           )

    Postgrex.query!(connection, "update episodes set status='ended' where id=$1", [
      UUID.dump!(fixture.episode.episode_id)
    ])

    assert {:ok, ended, _} = LiveEpisode.presence_snapshot(left)
    assert Projection.items(ended.presence_projection) == []
  end

  test "a pending seat gets its verified own association before entered", %{
    connection: connection,
    port: port
  } do
    assert %{rows: [[true]]} =
             Postgrex.query!(
               connection,
               "select enforced from sync_entry_rollout where singleton",
               []
             )

    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    person = associate_person(connection, fixture.episode)

    path =
      "/v1/sync?entry_confirmation=1&entry_generation=new&participant_devices=1&participant_device_admissions=2"

    {client, items, welcome} = connect_presence(port, path, fixture.identity)
    assert welcome["participant_identity_id"] == person

    refute Enum.any?(
             welcome["snapshot"]["participants"],
             &(&1["participant_id"] == fixture.identity.participant_id)
           )

    # The private welcome carries self identity while the public projection excludes it.
    assert items == []

    assert %{rows: [["joining"]]} =
             Postgrex.query!(connection, "select status from participants where id=$1", [
               UUID.dump!(fixture.identity.participant_id)
             ])

    Client.close(client)
  end

  defp associate_person(connection, episode) do
    person = UUID.generate()

    on_exit(fn ->
      Postgrex.query!(connection, "update participants set identity_id=null where tenant_id=$1", [
        UUID.dump!(episode.tenant_id)
      ])

      Postgrex.query!(connection, "delete from identities where id=$1", [UUID.dump!(person)])
    end)

    Postgrex.query!(
      connection,
      "insert into identities (id, tenant_id, kind, external_id, display_name) values ($1,$2,'user',$3,'Teacher')",
      [UUID.dump!(person), UUID.dump!(episode.tenant_id), person]
    )

    Postgrex.query!(
      connection,
      "update participants set identity_id=$1 where tenant_id=$2 and space_id=$3 and episode_id=$4",
      [
        UUID.dump!(person),
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.episode_id)
      ]
    )

    person
  end

  defp connect_presence(port, path, identity) do
    token =
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

    {:ok, client} = Client.connect(port, path, [{"user-agent", "Mozilla/5.0 iPhone Mobile"}])

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token,
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })

    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence", "items" => items}, client} = Client.recv(client)

    assert Map.has_key?(welcome, "participant_identity_id") ==
             String.contains?(path, "participant_device_admissions=2")

    {client, items, welcome}
  end
end
