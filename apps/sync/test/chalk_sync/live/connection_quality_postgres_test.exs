defmodule ChalkSync.Live.ConnectionQualityPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  setup_all do
    connections = SyncPostgres.start_connections(@database_url, 4)

    previous =
      for key <- [:stateholder, :database_connections, :media_plane],
          into: %{},
          do: {key, Application.get_env(:chalk_sync, key)}

    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(outcomes: %{observe_episode_publications: {:ok, []}})

    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

    on_exit(fn ->
      for {key, value} <- previous do
        if value,
          do: Application.put_env(:chalk_sync, key, value),
          else: Application.delete_env(:chalk_sync, key)
      end

      for pid <- connections, do: ChalkSync.TestProcess.stop(pid)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    fixture =
      SyncPostgres.seed_episode(connection, 2, %{}, %{
        participants: [%{}, %{role: "collaborator"}]
      })

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host, guest] = fixture.identities
    {:ok, fixture: fixture, host: host, guest: guest}
  end

  test "guests see a quality only when they asked for it, and it leaves with the socket",
       %{port: port, host: host, guest: guest} do
    path = "/v1/sync?connection_quality=1"
    {welcome, _items, sender} = session(port, path, guest)
    assert welcome["connection_quality"] == true

    # The host asked for the extension and sees the guest's tier as a presence event.
    {host_welcome, _items, observer} = session(port, path, host)
    assert host_welcome["connection_quality"] == true

    sender = send_quality(sender, "weak")
    assert {%{"connection_quality" => "weak"}, observer} = next_presence_item(observer, guest)

    sender = send_quality(sender, "poor")
    assert {%{"connection_quality" => "poor"}, observer} = next_presence_item(observer, guest)

    # An earlier SDK never sees the key, and a frame from it is a protocol error.
    {old_welcome, _items, old} = session(port, "/v1/sync", host)
    refute Map.has_key?(old_welcome, "connection_quality")
    sender = send_quality(sender, "weak")
    assert {item, old} = next_presence_item(old, guest)
    refute Map.has_key?(item, "connection_quality")
    old = Client.send_json(old, %{"type" => "connection_quality_set", "quality" => "weak"})
    assert {:json, %{"type" => "error", "code" => "protocol_error"}, _old} = Client.recv(old)

    # When the guest leaves, the tier goes with the seat.
    assert {%{"connection_quality" => "weak"}, observer} = next_presence_item(observer, guest)
    Client.close_tcp(sender)
    assert {%{"state" => "disconnected"} = gone, observer} = next_presence_item(observer, guest)
    refute Map.has_key?(gone, "connection_quality")
    Client.close_tcp(observer)
  end

  # Opens a socket and recovers it, returning the presence items of its snapshot.
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

    client = Client.acknowledge_recovery(client, welcome)
    {items, client} = recover(client, [])
    {welcome, items, client}
  end

  defp recover(client, items) do
    case Client.recv(client) do
      {:json, %{"type" => "recovery_complete"}, client} ->
        {items, client}

      {:json, %{"type" => "projection_snapshot", "stream" => "presence", "items" => found},
       client} ->
        recover(client, found)

      {:json, _other, client} ->
        recover(client, items)
    end
  end

  defp send_quality(client, quality),
    do: Client.send_json(client, %{"type" => "connection_quality_set", "quality" => quality})

  defp next_presence_item(client, identity) do
    case Client.recv(client) do
      {:json, %{"type" => "projection_event", "stream" => "presence", "item" => item}, client} ->
        if item["participant_id"] == identity.participant_id,
          do: {item, client},
          else: next_presence_item(client, identity)

      {:json, _other, client} ->
        next_presence_item(client, identity)
    end
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
end
