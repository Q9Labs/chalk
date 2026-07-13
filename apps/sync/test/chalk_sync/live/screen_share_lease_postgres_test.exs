defmodule ChalkSync.Live.ScreenShareLeasePostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.PublicationFence
  alias ChalkSync.Live.ScreenShareLease
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  @now ~U[2026-07-12 12:00:00.000000Z]

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      connections = SyncPostgres.start_connections(@database_url, 2)
      on_exit(fn -> Enum.each(connections, &stop_connection/1) end)
      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    connection = hd(connections)
    fixture = seed_fixture(connection)

    on_exit(fn -> cleanup_fixture(connection, fixture) end)

    {:ok, fixture: fixture}
  end

  test "serializes contention in Postgres and permits takeover only after expiry", %{
    connections: [first, second],
    fixture: fixture
  } do
    [owner, contender] = fixture.identities

    assert {:ok, lease} =
             ScreenShareLease.acquire(
               first,
               fixture.session,
               owner.participant_session_id,
               owner.participant_session_generation,
               now: @now,
               lease_id: "00000000-0000-4000-8000-000000000010"
             )

    assert lease.lease_generation == 1

    assert {:error, :screen_share_in_use} =
             ScreenShareLease.acquire(
               second,
               fixture.session,
               contender.participant_session_id,
               contender.participant_session_generation,
               now: DateTime.add(@now, 9_999, :millisecond)
             )

    takeover_at = DateTime.add(@now, 10_000, :millisecond)

    assert {:ok, takeover} =
             ScreenShareLease.acquire(
               second,
               fixture.session,
               contender.participant_session_id,
               contender.participant_session_generation,
               now: takeover_at,
               lease_id: "00000000-0000-4000-8000-000000000011"
             )

    assert takeover.lease_generation == 2
    assert takeover.owner_participant_session_id == contender.participant_session_id
    assert {:error, :lease_not_owned} = ScreenShareLease.release(first, fixture.session, lease)
    assert :ok = ScreenShareLease.release(second, fixture.session, takeover)
  end

  test "renews within the hard lifetime and expires in a bounded batch", %{
    connections: [connection | _],
    fixture: fixture
  } do
    owner = hd(fixture.identities)

    assert {:ok, lease} =
             ScreenShareLease.acquire(
               connection,
               fixture.session,
               owner.participant_session_id,
               owner.participant_session_generation,
               now: @now,
               renewal_ms: 5_000,
               hard_lifetime_ms: 10_000
             )

    assert {:ok, renewed} =
             ScreenShareLease.renew(connection, fixture.session, lease,
               now: DateTime.add(@now, 4_000, :millisecond),
               renewal_ms: 10_000
             )

    assert renewed.renewed_until == renewed.hard_expires_at
    assert {:ok, 0} = ScreenShareLease.expire(connection, DateTime.add(@now, 9_999, :millisecond))

    assert {:ok, 1} =
             ScreenShareLease.expire(connection, DateTime.add(@now, 10_000, :millisecond))

    assert {:error, :lease_expired} =
             ScreenShareLease.renew(connection, fixture.session, renewed,
               now: DateTime.add(@now, 10_001, :millisecond)
             )

    assert {:error, :invalid_limit} = ScreenShareLease.expire(connection, @now, 501)
  end

  test "same owner acquisition renews the existing lease while another owner remains excluded", %{
    connections: [first, second],
    fixture: fixture
  } do
    [owner, contender] = fixture.identities
    original_id = "00000000-0000-4000-8000-000000000012"

    assert {:ok, original} =
             ScreenShareLease.acquire(
               first,
               fixture.session,
               owner.participant_session_id,
               owner.participant_session_generation,
               now: @now,
               renewal_ms: 5_000,
               hard_lifetime_ms: 20_000,
               lease_id: original_id
             )

    assert {:ok, duplicate} =
             ScreenShareLease.acquire(
               first,
               fixture.session,
               owner.participant_session_id,
               owner.participant_session_generation,
               now: DateTime.add(@now, 4_000, :millisecond),
               renewal_ms: 5_000,
               hard_lifetime_ms: 20_000,
               lease_id: "00000000-0000-4000-8000-000000000013"
             )

    assert duplicate.lease_id == original_id
    assert duplicate.lease_generation == original.lease_generation
    assert duplicate.renewed_until == DateTime.add(@now, 9_000, :millisecond)

    assert {:error, :screen_share_in_use} =
             ScreenShareLease.acquire(
               second,
               fixture.session,
               contender.participant_session_id,
               contender.participant_session_generation,
               now: DateTime.add(@now, 6_000, :millisecond)
             )

    assert :ok = ScreenShareLease.release(first, fixture.session, duplicate)
  end

  test "checks active publication fences by participant and source", %{
    connections: [connection | _],
    fixture: fixture
  } do
    identity = hd(fixture.identities)
    participant = identity.participant_session_id
    generation = identity.participant_session_generation
    operation_id = "00000000-0000-4000-8000-000000000020"
    insert_external_operation(connection, fixture, identity, operation_id)

    Postgrex.query!(
      connection,
      """
      insert into sync_publication_fences (
        tenant_id, room_id, session_id, participant_session_id, participant_generation,
        source, external_operation_id, created_at, expires_at
      ) values ($1, $2, $3, $4, $5, 'camera', $6, $7, $8)
      """,
      [
        UUID.dump!(fixture.session.tenant_id),
        UUID.dump!(fixture.session.room_id),
        UUID.dump!(fixture.session.session_id),
        UUID.dump!(participant),
        generation,
        UUID.dump!(operation_id),
        @now,
        DateTime.add(@now, 30_000, :millisecond)
      ]
    )

    assert :owned =
             PublicationFence.check(
               connection,
               fixture.session,
               participant,
               generation,
               :camera,
               operation_id,
               @now
             )

    assert {:fenced, ^operation_id} =
             PublicationFence.check(
               connection,
               fixture.session,
               participant,
               generation,
               :camera,
               "00000000-0000-4000-8000-000000000021",
               @now
             )

    assert :clear =
             PublicationFence.check(
               connection,
               fixture.session,
               participant,
               generation,
               :microphone,
               operation_id,
               @now
             )

    assert :clear =
             PublicationFence.check(
               connection,
               fixture.session,
               participant,
               generation,
               :camera,
               operation_id,
               DateTime.add(@now, 30_000, :millisecond)
             )

    assert :clear =
             PublicationFence.check(
               connection,
               fixture.session,
               participant,
               generation + 1,
               :camera,
               operation_id,
               @now
             )

    assert {:error, :invalid_generation} =
             PublicationFence.check(
               connection,
               fixture.session,
               participant,
               0,
               :camera,
               operation_id,
               @now
             )
  end

  defp insert_external_operation(connection, fixture, identity, operation_id) do
    Postgrex.query!(
      connection,
      """
      insert into sync_external_operations (
        tenant_id, room_id, session_id, external_operation_id, request_key,
        request_fingerprint, operation_name, target_participant_session_id,
        target_participant_generation, payload
      ) values ($1, $2, $3, $4, 'remove-request-0001', $5, 'remove_participant', $6, $7, $8)
      """,
      [
        UUID.dump!(fixture.session.tenant_id),
        UUID.dump!(fixture.session.room_id),
        UUID.dump!(fixture.session.session_id),
        UUID.dump!(operation_id),
        :crypto.hash(:sha256, "remove-request-0001"),
        UUID.dump!(identity.participant_session_id),
        identity.participant_session_generation,
        %{"participant_session_id" => identity.participant_session_id}
      ]
    )
  end

  defp seed_fixture(connection) do
    session = %SessionKey{
      tenant_id: UUID.generate(),
      room_id: UUID.generate(),
      session_id: UUID.generate()
    }

    participants =
      Enum.map(1..2, fn generation ->
        %{
          participant_session_id: UUID.generate(),
          participant_session_generation: generation
        }
      end)

    Postgrex.transaction(connection, fn transaction ->
      Postgrex.query!(transaction, "insert into tenants (id, name) values ($1, 'Live Test')", [
        UUID.dump!(session.tenant_id)
      ])

      Postgrex.query!(
        transaction,
        """
        insert into rooms (id, name, tenant_id, status, slug, media_plane)
        values ($1, 'Live Test Room', $2, 'active', $3, 'cf_rtk')
        """,
        [
          UUID.dump!(session.room_id),
          UUID.dump!(session.tenant_id),
          "live-test-#{session.room_id}"
        ]
      )

      Postgrex.query!(
        transaction,
        """
        insert into room_sessions (id, status, room_id, tenant_id, started_at)
        values ($1, 'active', $2, $3, now())
        """,
        [
          UUID.dump!(session.session_id),
          UUID.dump!(session.room_id),
          UUID.dump!(session.tenant_id)
        ]
      )

      Enum.each(participants, fn participant ->
        Postgrex.query!(
          transaction,
          """
          insert into participants (
            id, name, capabilities, tenant_id, room_id, session_id,
            generation, status, joined_at
          ) values ($1, 'Live Participant', '{}', $2, $3, $4, $5, 'active', now())
          """,
          [
            UUID.dump!(participant.participant_session_id),
            UUID.dump!(session.tenant_id),
            UUID.dump!(session.room_id),
            UUID.dump!(session.session_id),
            participant.participant_session_generation
          ]
        )
      end)

      Postgrex.query!(
        transaction,
        """
        insert into sync_session_control (
          tenant_id, room_id, session_id, folded_state, state_schema_version,
          state_digest, snapshot_bytes
        ) values ($1, $2, $3, '{}', 1, $4, 2)
        """,
        [
          UUID.dump!(session.tenant_id),
          UUID.dump!(session.room_id),
          UUID.dump!(session.session_id),
          :crypto.hash(:sha256, "live-test-state")
        ]
      )
    end)

    %{session: session, identities: participants}
  end

  defp cleanup_fixture(connection, fixture) do
    tenant_id = UUID.dump!(fixture.session.tenant_id)

    Postgrex.transaction(connection, fn transaction ->
      Enum.each(
        [
          "sync_publication_fences",
          "sync_screen_share_leases",
          "sync_external_operations",
          "sync_session_control",
          "participants",
          "room_sessions",
          "rooms"
        ],
        fn table ->
          Postgrex.query!(transaction, "delete from #{table} where tenant_id = $1", [tenant_id])
        end
      )

      Postgrex.query!(transaction, "delete from tenants where id = $1", [tenant_id])
    end)
  end

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
