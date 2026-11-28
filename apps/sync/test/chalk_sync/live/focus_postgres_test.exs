defmodule ChalkSync.Live.FocusPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

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
      SyncPostgres.seed_episode(connection, 3, %{focus: %{"enabled" => true}}, %{
        participants: [
          %{
            capabilities:
              Reducer.new(UUID.generate()).role_capabilities["owner"] --
                ["focus.exempt"]
          },
          %{role: "observer"},
          %{role: "collaborator"}
        ]
      })

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host, guest, collaborator] = fixture.identities
    {:ok, fixture: fixture, host: host, guest: guest, collaborator: collaborator}
  end

  test "focus state is negotiated, visible only to viewers, and durable when it closes",
       %{
         port: port,
         connection: connection,
         fixture: fixture,
         host: host,
         guest: guest,
         collaborator: collaborator
       } do
    path = "/v1/sync?app_state=1"
    {welcome, _items, sender} = session(port, path, guest)
    assert welcome["app_state"] == true

    {host_welcome, _items, viewer} = session(port, path, host)
    assert host_welcome["app_state"] == true
    {_collaborator_welcome, _items, nonviewer} = session(port, path, collaborator)

    sender = send_state(sender, "background", false)

    assert {%{"focus_app_state" => "background", "focus_windowed" => false}, viewer} =
             next_presence_item(viewer, guest)

    assert {item, nonviewer} = next_presence_item(nonviewer, guest)
    refute Map.has_key?(item, "focus_app_state")
    refute Map.has_key?(item, "focus_windowed")

    # The tracked participant always sees their own state, even without focus.view.
    assert {%{"focus_app_state" => "background"}, sender} = next_presence_item(sender, guest)

    sender = send_state(sender, "active", false)
    assert {%{"focus_app_state" => "active"}, viewer} = next_presence_item(viewer, guest)

    [[state, windowed]] =
      Postgrex.query!(
        connection,
        "select state, windowed from episode_focus_intervals where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4",
        [
          ChalkSync.UUID.dump!(fixture.episode.tenant_id),
          ChalkSync.UUID.dump!(fixture.episode.space_id),
          ChalkSync.UUID.dump!(fixture.episode.episode_id),
          ChalkSync.UUID.dump!(guest.participant_id)
        ]
      ).rows

    assert {state, windowed} == {"background", false}

    # An older client neither negotiates nor sees the extension, and cannot send its frame.
    {old_welcome, old_items, old} = session(port, "/v1/sync", host)
    refute Map.has_key?(old_welcome, "app_state")
    {old_item, old} = presence_snapshot_item(old, old_items, guest)
    refute Map.has_key?(old_item, "focus_app_state")

    old =
      Client.send_json(old, %{
        "type" => "app_state_set",
        "state" => "inactive",
        "windowed" => false
      })

    assert {:json, %{"type" => "error", "code" => "protocol_error"}, _old} = Client.recv(old)

    Client.close_tcp(sender)
    assert {%{"state" => "disconnected"} = gone, viewer} = next_presence_item(viewer, guest)
    refute Map.has_key?(gone, "focus_app_state")
    Client.close_tcp(viewer)
    Client.close_tcp(nonviewer)
  end

  test "a step away and an allowance are recorded and shown to viewers", %{
    port: port,
    connection: connection,
    fixture: fixture,
    host: host,
    guest: guest
  } do
    path = "/v1/sync?app_state=1"
    {_welcome, _items, sender} = session(port, path, guest)
    {_welcome, _items, viewer} = session(port, path, host)

    {ack, sender} = command(sender, "set_focus_step_away", %{"reason" => "reading"})
    assert %{"type" => "ack", "outcome" => "committed"} = ack

    assert {%{"focus_step_away_reason" => "reading"}, viewer} =
             next_presence_item(viewer, guest)

    {ack, sender} = command(sender, "clear_focus_step_away", %{})
    assert %{"type" => "ack", "outcome" => "committed"} = ack

    assert {back, viewer} = next_presence_item(viewer, guest)
    refute Map.has_key?(back, "focus_step_away_reason")

    {ack, viewer} = command(viewer, "open_focus_allowance", %{"minutes" => 5})
    assert %{"type" => "ack", "outcome" => "committed"} = ack

    {ack, viewer} = command(viewer, "close_focus_allowance", %{})
    assert %{"type" => "ack", "outcome" => "committed"} = ack

    [[allowances]] =
      Postgrex.query!(
        connection,
        "select count(*) from episode_focus_allow_windows where tenant_id=$1 and space_id=$2 and episode_id=$3 and ended_at is not null",
        [
          ChalkSync.UUID.dump!(fixture.episode.tenant_id),
          ChalkSync.UUID.dump!(fixture.episode.space_id),
          ChalkSync.UUID.dump!(fixture.episode.episode_id)
        ]
      ).rows

    assert allowances == 1
    Client.close_tcp(sender)
    Client.close_tcp(viewer)
  end

  defp command(client, name, payload) do
    id = UUID.generate()

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => id,
        "name" => name,
        "payload" => payload
      })

    receive_ack(client, id)
  end

  defp receive_ack(client, id) do
    case Client.recv(client) do
      {:json, %{"command_id" => ^id} = response, client} -> {response, client}
      {:json, _other, client} -> receive_ack(client, id)
    end
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

  defp send_state(client, state, windowed),
    do:
      Client.send_json(client, %{
        "type" => "app_state_set",
        "state" => state,
        "windowed" => windowed
      })

  defp presence_snapshot_item(client, items, identity) do
    case Enum.find(items, &(&1["participant_id"] == identity.participant_id)) do
      nil -> next_snapshot_item(client, identity)
      item -> {item, client}
    end
  end

  defp next_snapshot_item(client, identity) do
    case Client.recv(client) do
      {:json, %{"type" => "projection_snapshot", "stream" => "presence", "items" => items},
       client} ->
        presence_snapshot_item(client, items, identity)

      {:json, _other, client} ->
        next_snapshot_item(client, identity)
    end
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
