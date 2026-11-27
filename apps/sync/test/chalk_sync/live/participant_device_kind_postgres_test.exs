defmodule ChalkSync.Live.ParticipantDeviceKindPostgresTest do
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

  @both "participant_devices=1&participant_device_kinds=1"
  @iphone_agent "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
  @desktop_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

  test "a declared device kind is stored and shown, and decides the device type over the user agent",
       %{port: port, host: host, guest: guest} do
    item =
      guest_arrives(port, "/v1/sync?#{@both}", host, "device_kind=ipad", guest, @desktop_agent)

    assert %{"device_kind" => "ipad", "device_type" => "tablet"} = item
  end

  test "an unknown kind is ignored, so the user agent decides the type and no kind is shown",
       %{port: port, host: host, guest: guest} do
    item =
      guest_arrives(port, "/v1/sync?#{@both}", host, "device_kind=toaster", guest, @iphone_agent)

    assert item["device_type"] == "phone"
    refute Map.has_key?(item, "device_kind")
  end

  test "a client that declares nothing keeps the user-agent type and shows no kind",
       %{port: port, host: host, guest: guest} do
    item = guest_arrives(port, "/v1/sync?#{@both}", host, nil, guest, @desktop_agent)

    assert item["device_type"] == "computer"
    refute Map.has_key?(item, "device_kind")
  end

  test "an earlier SDK that asked only for participant devices never sees the kind",
       %{port: port, host: host, guest: guest} do
    item =
      guest_arrives(port, "/v1/sync?participant_devices=1", host, "device_kind=iphone", guest)

    assert item["device_type"] == "phone"
    refute Map.has_key?(item, "device_kind")
  end

  test "a client that asked for no device hints sees neither the type nor the kind",
       %{port: port, host: host, guest: guest} do
    item = guest_arrives(port, "/v1/sync", host, "device_kind=iphone", guest)

    refute Map.has_key?(item, "device_type")
    refute Map.has_key?(item, "device_kind")
  end

  # The host watches on `observer_path`; the guest joins with the kind query and user agent and leaves, and the
  # host's presence event for the guest is returned.
  defp guest_arrives(port, observer_path, host, kind_query, guest, agent \\ @desktop_agent) do
    {_welcome, _items, observer} = session(port, observer_path, host)
    guest_path = "/v1/sync?#{@both}" <> if(kind_query, do: "&#{kind_query}", else: "")
    {_welcome, _items, sender} = session(port, guest_path, guest, [{"user-agent", agent}])
    # Sync projects presence when a socket leaves, and the seat keeps its device hints.
    Client.close_tcp(sender)
    {item, observer} = next_presence_item(observer, guest)
    Client.close_tcp(observer)
    item
  end

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

  # Opens a socket and recovers it, returning the presence items of its snapshot.
  defp session(port, path, identity, headers \\ []) do
    {:ok, client} = Client.connect(port, path, headers)

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
