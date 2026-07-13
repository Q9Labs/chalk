defmodule ChalkSync.Live.SessionPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Live.ScreenShareLease
  alias ChalkSync.Live.Session
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  @role_capabilities %{
    "host" => ["publishScreen", "subscribe"],
    "cohost" => ["subscribe"],
    "participant" => ["subscribe"]
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

  test "terminal screen grant failure completes authority and releases the Session lease", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_session(connection, 1, %{role_capabilities: @role_capabilities})
    identity = hd(fixture.identities)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

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

    assert {%Session{screen_leases: %{}},
            %{"outcome" => "terminal_failure", "error_code" => "provider_denied"}} =
             Session.live_target(Session.new(fixture.session), identity, target)

    assert {:ok, lease} =
             ScreenShareLease.acquire(
               connection,
               fixture.session,
               identity.participant_session_id,
               identity.participant_session_generation
             )

    assert :ok = ScreenShareLease.release(connection, fixture.session, lease)
  end

  test "observed screen duplicates satisfy safely and confirmed loss releases the lease", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_session(connection, 2, %{role_capabilities: @role_capabilities})
    [identity, contender] = fixture.identities
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

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

    assert {%Session{} = state, %{"outcome" => "confirmed"}} =
             Session.live_target(Session.new(fixture.session), identity, target)

    publication = %{
      participant_session_id: identity.participant_session_id,
      source: :screen,
      enabled: true,
      publication_id: "provider-screen-publication"
    }

    MediaPlaneTestAdapter.put_outcome(
      adapter,
      :observe_session_publications,
      {:ok, [publication]}
    )

    assert {:ok, state, [%{"items" => [_publication]}]} = Session.reconcile(state)
    original_lease = Map.fetch!(state.screen_leases, identity.participant_session_id)

    assert {%Session{} = state, %{"outcome" => "satisfied"}} =
             Session.live_target(state, identity, target)

    assert 1 ==
             Enum.count(MediaPlaneTestAdapter.calls(adapter), fn {operation, _, _} ->
               operation == :grant_publication
             end)

    after_hard_expiry = DateTime.add(original_lease.hard_expires_at, 1, :millisecond)

    assert {:ok, state, []} = Session.reconcile(state, now: after_hard_expiry)
    rotated = Map.fetch!(state.screen_leases, identity.participant_session_id)
    assert rotated.lease_id != original_lease.lease_id
    assert rotated.lease_generation == original_lease.lease_generation + 1

    assert {:error, :screen_share_in_use} =
             ScreenShareLease.acquire(
               connection,
               fixture.session,
               contender.participant_session_id,
               contender.participant_session_generation,
               now: DateTime.add(after_hard_expiry, 1, :millisecond)
             )

    MediaPlaneTestAdapter.put_outcome(adapter, :observe_session_publications, {:ok, []})

    assert {:ok, %Session{screen_leases: %{}}, [loss_event]} =
             Session.reconcile(state, now: DateTime.add(after_hard_expiry, 2, :millisecond))

    assert loss_event["type"] == "projection_event"
    assert loss_event["item"]["enabled"] == false
    assert loss_event["item"]["publication_id"] == nil

    assert {:ok, lease} =
             ScreenShareLease.acquire(
               connection,
               fixture.session,
               contender.participant_session_id,
               contender.participant_session_generation
             )

    assert :ok = ScreenShareLease.release(connection, fixture.session, lease)
  end

  test "reconciliation recovers an observed owner's durable lease after local state loss", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_session(connection, 2, %{role_capabilities: @role_capabilities})
    [identity, contender] = fixture.identities
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    assert {:ok, durable_lease} =
             ScreenShareLease.acquire(
               connection,
               fixture.session,
               identity.participant_session_id,
               identity.participant_session_generation
             )

    publication = %{
      participant_session_id: identity.participant_session_id,
      source: :screen,
      enabled: true,
      publication_id: "provider-restart-screen"
    }

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{observe_session_publications: {:ok, [publication]}}
      )

    previous_media_plane = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> restore_env(:media_plane, previous_media_plane) end)

    assert {:ok, recovered, _recovery_frames, _broadcast_frames} =
             Session.register(Session.new(fixture.session), identity, self())

    assert recovered.screen_leases[identity.participant_session_id].lease_id ==
             durable_lease.lease_id

    after_hard_expiry = DateTime.add(durable_lease.hard_expires_at, 1, :millisecond)
    assert {:ok, recovered, []} = Session.reconcile(recovered, now: after_hard_expiry)
    assert recovered.screen_leases[identity.participant_session_id].lease_generation == 2

    assert {:error, :screen_share_in_use} =
             ScreenShareLease.acquire(
               connection,
               fixture.session,
               contender.participant_session_id,
               contender.participant_session_generation,
               now: DateTime.add(after_hard_expiry, 1, :millisecond)
             )
  end

  test "reconciliation ignores stale media observations and rejects cursor reuse", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_session(connection, 1, %{role_capabilities: @role_capabilities})
    identity = hd(fixture.identities)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    camera = %{
      participant_session_id: identity.participant_session_id,
      source: :camera,
      enabled: true,
      publication_id: "provider-camera-newer"
    }

    microphone = %{
      participant_session_id: identity.participant_session_id,
      source: :microphone,
      enabled: true,
      publication_id: "provider-microphone-newer"
    }

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    previous_media_plane = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> restore_env(:media_plane, previous_media_plane) end)

    MediaPlaneTestAdapter.put_outcome(
      adapter,
      :observe_session_publications,
      {:ok, %{incarnation: 4, sequence: 8, publications: [camera, microphone]}}
    )

    assert {:ok, newer, [%{"items" => newer_items}]} =
             Session.reconcile(Session.new(fixture.session))

    assert newer.media_observation_cursor == {4, 8}
    assert length(newer_items) == 2

    MediaPlaneTestAdapter.put_outcome(
      adapter,
      :observe_session_publications,
      {:ok, %{incarnation: 4, sequence: 7, publications: [camera]}}
    )

    assert {:ok, unchanged, []} = Session.reconcile(newer)
    assert unchanged == newer

    MediaPlaneTestAdapter.put_outcome(
      adapter,
      :observe_session_publications,
      {:ok, %{incarnation: 4, sequence: 8, publications: [camera]}}
    )

    assert {:error, :dependency_unavailable} = Session.reconcile(newer)
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
