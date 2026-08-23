defmodule ChalkSync.Live.EpisodePostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.Episode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Live.ScreenShareLease
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  @role_capabilities %{
    "owner" => ["publishScreen", "subscribe"],
    "collaborator" => ["subscribe"],
    "observer" => ["subscribe"]
  }

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_stateholder = Application.get_env(:chalk_sync, :stateholder)
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)

      Application.put_env(:chalk_sync, :stateholder, Postgres)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:stateholder, previous_stateholder)
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connection: hd(connections)}
    else
      :ok
    end
  end

  test "terminal screen grant failure completes authority and releases the Episode lease", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_episode(connection, 1, %{role_capabilities: @role_capabilities})
    identity = hd(fixture.identities)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{grant_publication: {:terminal_failure, :provider_denied}}
      )

    previous_media_plane = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> restore_env(:media_plane, previous_media_plane) end)

    target = %{
      operation_id: "screen-terminal-failure-01",
      name: :set_screen_share_enabled,
      enabled: true
    }

    assert {%Episode{screen_leases: %{}},
            %{"outcome" => "terminal_failure", "error_code" => "provider_denied"}} =
             Episode.live_target(Episode.new(fixture.episode), identity, target)

    assert {:ok, lease} =
             ScreenShareLease.acquire(
               connection,
               fixture.episode,
               identity.participant_id,
               identity.participant_generation
             )

    assert :ok = ScreenShareLease.release(connection, fixture.episode, lease)
  end

  test "observed screen duplicates satisfy safely and confirmed loss releases the lease", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_episode(connection, 2, %{role_capabilities: @role_capabilities})
    [identity, contender] = fixture.identities
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    previous_media_plane = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> restore_env(:media_plane, previous_media_plane) end)

    operation_id = "00000000-0000-4000-8000-000000000080"

    target = %{
      operation_id: operation_id,
      name: :set_screen_share_enabled,
      enabled: true
    }

    assert {%Episode{} = state, %{"outcome" => "confirmed"}} =
             Episode.live_target(Episode.new(fixture.episode), identity, target)

    publication = %{
      participant_id: identity.participant_id,
      source: :screen,
      enabled: true,
      publication_id: "provider-screen-publication"
    }

    MediaPlaneTestAdapter.put_outcome(
      adapter,
      :observe_episode_publications,
      {:ok, [publication]}
    )

    assert {:ok, state, [%{"items" => [_publication]}]} = Episode.reconcile(state)
    original_lease = Map.fetch!(state.screen_leases, identity.participant_id)

    assert {%Episode{} = state, %{"outcome" => "satisfied"}} =
             Episode.live_target(state, identity, target)

    assert 1 ==
             Enum.count(MediaPlaneTestAdapter.calls(adapter), fn {operation, _, _} ->
               operation == :grant_publication
             end)

    after_hard_expiry = DateTime.add(original_lease.hard_expires_at, 1, :millisecond)

    assert {:ok, state, []} = Episode.reconcile(state, now: after_hard_expiry)
    rotated = Map.fetch!(state.screen_leases, identity.participant_id)
    assert rotated.lease_id != original_lease.lease_id
    assert rotated.lease_generation == original_lease.lease_generation + 1

    assert {:error, :screen_share_in_use} =
             ScreenShareLease.acquire(
               connection,
               fixture.episode,
               contender.participant_id,
               contender.participant_generation,
               now: DateTime.add(after_hard_expiry, 1, :millisecond)
             )

    MediaPlaneTestAdapter.put_outcome(adapter, :observe_episode_publications, {:ok, []})

    assert {:ok, %Episode{screen_leases: %{}}, [loss_event]} =
             Episode.reconcile(state, now: DateTime.add(after_hard_expiry, 2, :millisecond))

    assert loss_event["type"] == "projection_event"
    assert loss_event["item"]["enabled"] == false
    assert loss_event["item"]["publication_id"] == nil

    assert {:ok, lease} =
             ScreenShareLease.acquire(
               connection,
               fixture.episode,
               contender.participant_id,
               contender.participant_generation
             )

    assert :ok = ScreenShareLease.release(connection, fixture.episode, lease)
  end

  test "reconciliation recovers an observed owner's durable lease after local state loss", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_episode(connection, 2, %{role_capabilities: @role_capabilities})
    [identity, contender] = fixture.identities
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    assert {:ok, durable_lease} =
             ScreenShareLease.acquire(
               connection,
               fixture.episode,
               identity.participant_id,
               identity.participant_generation
             )

    publication = %{
      participant_id: identity.participant_id,
      source: :screen,
      enabled: true,
      publication_id: "provider-restart-screen"
    }

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{observe_episode_publications: {:ok, [publication]}}
      )

    previous_media_plane = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> restore_env(:media_plane, previous_media_plane) end)

    assert {:ok, recovered, _recovery_frames, _broadcast_frames} =
             Episode.register(Episode.new(fixture.episode), identity, self())

    assert recovered.screen_leases[identity.participant_id].lease_id ==
             durable_lease.lease_id

    after_hard_expiry = DateTime.add(durable_lease.hard_expires_at, 1, :millisecond)
    assert {:ok, recovered, []} = Episode.reconcile(recovered, now: after_hard_expiry)
    assert recovered.screen_leases[identity.participant_id].lease_generation == 2

    assert {:error, :screen_share_in_use} =
             ScreenShareLease.acquire(
               connection,
               fixture.episode,
               contender.participant_id,
               contender.participant_generation,
               now: DateTime.add(after_hard_expiry, 1, :millisecond)
             )
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
