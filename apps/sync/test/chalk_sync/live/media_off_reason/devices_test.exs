defmodule ChalkSync.Live.MediaOffReasonDevicesPostgresTest do
  use ChalkSync.ServerCase, async: false
  use ChalkSync.Live.MediaOffReasonCase

  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.MediaPauses
  alias ChalkSync.UUID

  @old_item_keys ["enabled", "participant_id", "publication_id", "source"]

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

  # Device A missed the stop while offline. Device B of the same participant then publishes again, so the media plane
  # lists an enabled publication. A recovers by snapshot with an older intent; the item must still say the host stopped
  # the source after A's intent, or A resumes without answering the stop. B's newer intent compares against the same
  # revision and keeps.
  test "a live publication from another device still carries the retained stop",
       %{port: port, fixture: fixture, host: host, guest: guest} do
    revision = mute(host, guest)

    use_adapter(%{
      observe_episode_publications:
        {:ok,
         [
           %{
             participant_id: guest.participant_id,
             source: :microphone,
             enabled: true,
             publication_id: "device-b-microphone"
           }
         ]}
    })

    {:ok, recovered, _frames} = LiveEpisode.reconcile(LiveEpisode.new(fixture.episode))

    assert [
             %{
               "enabled" => true,
               "publication_id" => "device-b-microphone",
               "off_reason" => "host",
               "off_revision" => ^revision
             }
           ] = recovered.media_items

    {welcome, items} = media_session(port, "/v1/sync?media_off_reason=1", guest, nil)
    assert welcome["media_off_reason"] == true
    assert [%{"enabled" => true, "off_reason" => "host", "off_revision" => ^revision}] = items

    {_welcome, old_items} = media_session(port, "/v1/sync", guest, nil)
    assert [item] = old_items
    assert item |> Map.keys() |> Enum.sort() == @old_item_keys
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
end
