defmodule ChalkSync.Live.ScreenShareLeaseEpisodeTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
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

    on_exit(fn ->
      for {key, value} <- previous do
        if value,
          do: Application.put_env(:chalk_sync, key, value),
          else: Application.delete_env(:chalk_sync, key)
      end

      for pid <- connections, do: ChalkSync.TestProcess.stop(pid)
    end)

    {:ok, connections: connections}
  end

  setup %{connections: [connection | _]} do
    fixture =
      SyncPostgres.seed_episode(connection, 2, %{}, %{
        participants: [%{}, %{role: "collaborator"}]
      })

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    [host, guest] = fixture.identities
    {:ok, fixture: fixture, host: host, guest: guest}
  end

  # The coordinator looks every 15 s and the media plane reports the same cursor while the share runs.
  # An equal observation must renew the lease, or the lease lapses and a guest can take it.
  test "a look at an unchanged observation renews the lease of the sharer",
       %{connections: [connection | _], fixture: fixture, host: host} do
    observation = observation(7, [screen(host)])
    use_adapter(observation)
    live = LiveEpisode.new(fixture.episode)

    {live, result} = enable_screen(live, host)
    assert result["outcome"] in ["confirmed", "satisfied"]
    %{hard_expires_at: hard} = lease_row(connection, fixture)
    acquired_at = DateTime.add(hard, -30_000, :millisecond)

    assert {:ok, live, _} =
             LiveEpisode.reconcile(live, now: DateTime.add(acquired_at, 1_000, :millisecond))

    first = lease_row(connection, fixture)

    # The coordinator's next look reports the same cursor.
    assert {:ok, _live, _} =
             LiveEpisode.reconcile(live, now: DateTime.add(acquired_at, 8_000, :millisecond))

    second = lease_row(connection, fixture)
    assert DateTime.compare(second.renewed_until, first.renewed_until) == :gt
    assert DateTime.compare(second.renewed_until, hard) in [:lt, :eq]
  end

  # The hard cap (30 s) would end the lease before the next look while the share still runs, and a guest could
  # take the lapsed lease. The look replaces the lease before that.
  test "a look near the hard cap replaces the lease of the sharer",
       %{connections: [connection | _], fixture: fixture, host: host} do
    use_adapter(observation(7, [screen(host)]))
    live = LiveEpisode.new(fixture.episode)

    {live, _} = enable_screen(live, host)
    old = lease_row(connection, fixture)
    acquired_at = DateTime.add(old.hard_expires_at, -30_000, :millisecond)

    assert {:ok, _live, _} =
             LiveEpisode.reconcile(live, now: DateTime.add(acquired_at, 25_000, :millisecond))

    row = lease_row(connection, fixture)
    refute row.lease_id == old.lease_id
    assert DateTime.compare(row.hard_expires_at, old.hard_expires_at) == :gt
    assert DateTime.compare(row.renewed_until, old.hard_expires_at) == :gt
  end

  # The release of an ended share failed, so the row stays. The same person's next share starts a new lease with a
  # full hard cap and does not inherit the old id and cap.
  test "a share that follows a failed release gets a fresh lease",
       %{connections: [connection | _], fixture: fixture, host: host} do
    use_adapter(observation(1, []))
    live = LiveEpisode.new(fixture.episode)
    {live, _} = enable_screen(live, host)
    old = lease_row(connection, fixture)

    # The release failed: Live.Episode forgot the lease and the row is still there.
    live = %{live | screen_leases: %{}}

    {_live, result} = enable_screen(live, host)
    assert result["outcome"] in ["confirmed", "satisfied"]
    row = lease_row(connection, fixture)

    refute row.lease_id == old.lease_id
    assert DateTime.compare(row.hard_expires_at, old.hard_expires_at) == :gt
  end

  defp enable_screen(live, identity) do
    LiveEpisode.live_target(live, identity, %{
      name: :set_screen_share_enabled,
      operation_id: UUID.generate(),
      enabled: true
    })
  end

  defp screen(identity) do
    %{
      participant_id: identity.participant_id,
      source: :screen,
      enabled: true,
      publication_id: "pub-#{identity.participant_id}"
    }
  end

  defp observation(sequence, publications),
    do: {:ok, %{incarnation: 1, sequence: sequence, publications: publications}}

  defp use_adapter(observation) do
    previous = Application.get_env(:chalk_sync, :media_plane)

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(outcomes: %{observe_episode_publications: observation})

    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> Application.put_env(:chalk_sync, :media_plane, previous) end)
  end

  defp lease_row(connection, fixture) do
    %{rows: [[lease_id, renewed_until, hard_expires_at]]} =
      Postgrex.query!(
        connection,
        "select lease_id, renewed_until, hard_expires_at from sync_screen_share_leases where tenant_id = $1 and episode_id = $2",
        [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.episode_id)]
      )

    %{lease_id: lease_id, renewed_until: renewed_until, hard_expires_at: hard_expires_at}
  end
end
