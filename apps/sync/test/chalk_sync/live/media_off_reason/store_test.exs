defmodule ChalkSync.Live.MediaOffReasonStorePostgresTest do
  use ChalkSync.ServerCase, async: false
  use ChalkSync.Live.MediaOffReasonCase

  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Stateholder.Postgres

  @old_item_keys ["enabled", "participant_id", "publication_id", "source"]

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
end
