defmodule ChalkSync.Live.MediaOffReasonPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.MediaPauses
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  @old_item_keys ["enabled", "participant_id", "publication_id", "source"]

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

  test "a host mute is stored with its stop revision, survives a fresh process and an accepted on",
       %{fixture: fixture, host: host, guest: guest} do
    key = {guest.participant_id, "microphone"}
    assert {:ok, stops} = Postgres.media_stops(fixture.episode)
    assert stops == %{}

    revision = mute(host, guest)

    assert {:ok, %{^key => ^revision}} = Postgres.media_stops(fixture.episode)

    assert {:ok, live, _frames} = LiveEpisode.reconcile(LiveEpisode.new(fixture.episode))

    assert [
             %{
               "participant_id" => participant_id,
               "source" => "microphone",
               "enabled" => false,
               "publication_id" => nil,
               "off_reason" => "host",
               "off_revision" => ^revision
             }
           ] = live.media_items

    assert participant_id == guest.participant_id

    use_adapter(%{})
    assert accept_on(live, guest)["outcome"] == "confirmed"
    assert {:ok, %{^key => ^revision}} = Postgres.media_stops(fixture.episode)
  end

  test "a device pause alone does not store a stop", %{fixture: fixture, guest: guest} do
    assert :ok = Postgres.set_media_pause(guest, :camera, "publisher|camera-track")
    assert {:ok, stops} = Postgres.media_stops(fixture.episode)
    assert stops == %{}
  end

  test "the media snapshot carries the reason only to a socket that negotiated it, on replay and on snapshot recovery",
       %{port: port, fixture: fixture, host: host, guest: guest} do
    cursor = control_cursor(guest)
    revision = mute(host, guest)

    # Inside retention: the control stream replays the stop event.
    inside = media_items(port, "/v1/sync?media_off_reason=1", guest, cursor)
    assert [%{"off_reason" => "host", "off_revision" => ^revision}] = inside

    # Beyond retention or with a digest Sync cannot match: the control stream falls back to a snapshot.
    stale = %{cursor | "state_digest" => String.duplicate("0", 64)}
    beyond = media_items(port, "/v1/sync?media_off_reason=1", guest, stale)
    assert [%{"off_reason" => "host", "off_revision" => ^revision}] = beyond

    # A first join has no cursor at all.
    fresh = media_items(port, "/v1/sync?media_off_reason=1", guest, nil)
    assert [%{"off_reason" => "host", "off_revision" => ^revision}] = fresh

    # An earlier SDK keeps the exact earlier item shape.
    for old_cursor <- [cursor, stale, nil] do
      assert [item] = media_items(port, "/v1/sync", guest, old_cursor)
      assert item |> Map.keys() |> Enum.sort() == @old_item_keys
      assert item["participant_id"] == guest.participant_id
      assert item["enabled"] == false
    end

    assert fixture.episode == guest.episode
  end

  # Intent revisions are per device. Device A went offline with an older on; device B heard the stop and its on was
  # accepted, and B's publication is not listed yet. A recovers from a fresh Sync process (or a snapshot fallback) and
  # must still see the stop, or it resumes an on that predates the host's stop.
  test "an accepted on from one device leaves the stop for a device whose on is older",
       %{fixture: fixture, host: host, guest: guest} do
    key = {guest.participant_id, "microphone"}
    revision = mute(host, guest)
    use_adapter(%{})

    {:ok, live, _frames} = LiveEpisode.reconcile(LiveEpisode.new(fixture.episode))
    {next, result} = accept_on_state(live, guest)

    assert result["outcome"] == "confirmed"
    assert {:ok, %{^key => ^revision}} = Postgres.media_stops(fixture.episode)
    assert next.media_stops == %{key => revision}

    assert {:ok, recovered, _frames} = LiveEpisode.reconcile(LiveEpisode.new(fixture.episode))

    assert [
             %{
               "participant_id" => participant_id,
               "source" => "microphone",
               "enabled" => false,
               "publication_id" => nil,
               "off_reason" => "host",
               "off_revision" => ^revision
             }
           ] = recovered.media_items

    assert participant_id == guest.participant_id
  end

  test "a newer stop replaces the older one and a repeated on changes nothing",
       %{connection: connection, fixture: fixture, host: host, guest: guest} do
    key = {guest.participant_id, "microphone"}
    first = mute(host, guest)
    use_adapter(%{})
    operation_id = UUID.generate()

    {:ok, live, _frames} = LiveEpisode.reconcile(LiveEpisode.new(fixture.episode))
    assert accept_on(live, guest, operation_id)["outcome"] == "confirmed"

    second = first + 1
    record_stop(connection, fixture, guest, second)

    assert accept_on(live, guest, operation_id)["outcome"] == "confirmed"
    assert {:ok, %{^key => ^second}} = Postgres.media_stops(fixture.episode)
  end

  test "the welcome carries media_off_reason only on a socket that negotiated it",
       %{port: port, host: host, guest: guest} do
    mute(host, guest)

    {welcome, _items} = media_session(port, "/v1/sync?media_off_reason=1", guest, nil)
    assert welcome["media_off_reason"] == true

    {welcome, _items} = media_session(port, "/v1/sync", guest, nil)
    refute Map.has_key?(welcome, "media_off_reason")
  end

  defp accept_on(live, guest, operation_id \\ UUID.generate()) do
    {_next, result} = accept_on_state(live, guest, operation_id)
    result
  end

  defp accept_on_state(live, guest, operation_id \\ UUID.generate()) do
    LiveEpisode.live_target(live, guest, %{
      name: :set_microphone_enabled,
      operation_id: operation_id,
      enabled: true
    })
  end

  defp record_stop(connection, fixture, guest, revision) do
    :ok =
      MediaPauses.record_stop(
        connection,
        fixture.episode,
        guest.participant_id,
        :microphone,
        revision
      )
  end

  defp use_adapter(outcomes) do
    previous = Application.get_env(:chalk_sync, :media_plane)

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: Map.put_new(outcomes, :observe_episode_publications, {:ok, []})
      )

    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> Application.put_env(:chalk_sync, :media_plane, previous) end)
    adapter
  end

  defp mute(host, guest) do
    {:ok, operation} =
      Operation.new("off_reason_mute_#{System.unique_integer([:positive])}", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    {episode, external} =
      Enum.find(claimed, fn {_episode, candidate} ->
        candidate.external_operation_id == operation_id
      end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               episode,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :applied, applied_revision: revision}} =
             Postgres.read_operation(guest.episode, operation_id)

    revision
  end

  defp control_cursor(identity) do
    {:ok, %{head: head}} = Postgres.recover(identity, nil)

    %{
      "revision" => head.revision,
      "state_schema_version" => head.state_schema_version,
      "state_digest" => Base.encode16(head.digest, case: :lower)
    }
  end

  defp media_items(port, path, identity, cursor),
    do: port |> media_session(path, identity, cursor) |> elem(1)

  defp media_session(port, path, identity, cursor) do
    {:ok, client} = Client.connect(port, path)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(identity),
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], fn
            "control" -> {"control", %{"cursor" => cursor}}
            stream -> {stream, %{"cursor" => nil}}
          end)
      })

    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    assert welcome["mode"] == if(is_nil(cursor) or stale?(cursor), do: "snapshot", else: "replay")

    {items, client} = recv_media(client, welcome)

    Client.close_tcp(client)
    {welcome, items}
  end

  defp stale?(%{"state_digest" => digest}), do: digest == String.duplicate("0", 64)

  defp recv_media(client, %{"mode" => "snapshot"} = welcome),
    do: client |> Client.acknowledge_recovery(welcome) |> recv_media()

  defp recv_media(client, %{"mode" => "replay"}) do
    assert {:json, %{"type" => "replay_page"} = page, client} = Client.recv(client)
    client |> Client.acknowledge_recovery(page) |> recv_media()
  end

  defp recv_media(client) do
    case Client.recv(client) do
      {:json, %{"type" => "projection_snapshot", "stream" => "media", "items" => items}, client} ->
        {items, client}

      {:json, _other, client} ->
        recv_media(client)
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
