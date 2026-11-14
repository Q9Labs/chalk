defmodule ChalkSync.Retention.CleanupWorkerLeasesTest do
  use ChalkSync.Retention.CleanupWorkerCase, async: false

  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @now ~U[2026-07-12 00:00:00.000000Z]
  @retention_seconds 7 * 24 * 60 * 60

  test "defers a middle-sequence Episode until the earlier chat prefix is cleaned", %{
    connections: connections
  } do
    connection = hd(connections)
    middle = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, middle)

    earlier = seed_ended_episode_in_scope(connection, middle, @retention_seconds + 2)
    cleanup_fixture(connection, earlier)

    newer = seed_shared_episode(connection, middle)
    seed_middle_chat_stream(connection, earlier, middle, newer)

    assert chat_stream_state(connection, middle) == [43, 6, 38, 38]
    assert {:ok, %Result{episodes: 1}} = run_cleanup(connection, batch_size: 16)
    assert checkpointed?(connection, earlier)
    refute checkpointed?(connection, middle)
    assert chat_stream_state(connection, middle) == [43, 22, 22, 22]

    assert {:ok, %Result{episodes: 1}} = run_cleanup(connection, batch_size: 16)
    assert checkpointed?(connection, middle)
    assert chat_stream_state(connection, middle) == [43, 23, 21, 21]
  end

  test "deletes expired screen-share leases while deferring unexpired leases", %{
    connections: connections
  } do
    connection = hd(connections)
    expired = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, expired)
    insert_screen_share_lease(connection, expired, DateTime.add(@now, -60, :second))

    unexpired = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, unexpired)
    insert_screen_share_lease(connection, unexpired, DateTime.add(@now, 60, :second))

    assert {:ok, %Result{episodes: 1} = result} = run_cleanup(connection, batch_size: 16)
    assert result.screen_share_lease_rows == 1
    assert result.screen_share_lease_bytes > 0
    assert checkpointed?(connection, expired)
    refute checkpointed?(connection, unexpired)
    assert screen_share_lease_count(connection, expired) == 0
    assert screen_share_lease_count(connection, unexpired) == 1
  end

  defp seed_ended_episode_in_scope(connection, scope_fixture, age_seconds) do
    fixture =
      SyncPostgres.seed_episode(
        connection,
        1,
        %{},
        %{tenant_id: scope_fixture.episode.tenant_id, space_id: scope_fixture.episode.space_id}
      )

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(
               hd(fixture.identities),
               operation("retention_prefix_episode_end", :end_episode, %{})
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               operation_id,
               {:applied, :episode_ended, %{"reason" => "ended_by_participant"}}
             )

    synchronize_event_counters(connection, fixture)
    age_ended_episode(connection, fixture, age_seconds)
    fixture
  end

  defp seed_middle_chat_stream(connection, earlier, middle, newer) do
    earlier_identity = hd(earlier.identities)
    middle_identity = middle.identity

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_streams (
        tenant_id, space_id, head_sequence, retained_floor_sequence,
        message_count, message_bytes
      ) values ($1, $2, 43, 6, 38, 38)
      """,
      space_scope(middle)
    )

    Enum.each(6..43, fn sequence ->
      {episode_id, participant_id, participant_generation} =
        cond do
          sequence <= 21 ->
            {earlier.episode.episode_id, earlier_identity.participant_id,
             earlier_identity.participant_generation}

          sequence == 22 ->
            {middle.episode.episode_id, middle_identity.participant_id,
             middle_identity.participant_generation}

          true ->
            {newer.episode_id, newer.participant_id, 1}
        end

      Postgrex.query!(
        connection,
        """
        insert into sync_chat_messages (
          tenant_id, space_id, episode_id, sequence, message_id,
          participant_id, participant_generation,
          client_message_id, request_fingerprint, display_name, message_text,
          encoded_bytes, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Prefix', 'message', 1, $10)
        """,
        space_scope(middle) ++
          [
            UUID.dump!(episode_id),
            sequence,
            UUID.dump!(UUID.generate()),
            UUID.dump!(participant_id),
            participant_generation,
            "prefix-message-#{sequence}",
            :crypto.hash(:sha256, "prefix-#{sequence}"),
            @now
          ]
      )
    end)
  end

  defp insert_screen_share_lease(connection, fixture, hard_expires_at) do
    identity = fixture.identity

    Postgrex.query!(
      connection,
      """
      insert into sync_screen_share_leases (
        tenant_id, space_id, episode_id, lease_id, owner_participant_id,
        owner_generation, lease_generation, status, acquired_at, renewed_until, hard_expires_at
      ) values ($1, $2, $3, $4, $5, $6, 1, 'active', $7, $8, $9)
      """,
      episode_scope(fixture) ++
        [
          UUID.dump!(UUID.generate()),
          UUID.dump!(identity.participant_id),
          identity.participant_generation,
          DateTime.add(hard_expires_at, -70, :second),
          DateTime.add(hard_expires_at, -30, :second),
          hard_expires_at
        ]
    )
  end

  defp screen_share_lease_count(connection, fixture) do
    [[count]] =
      Postgrex.query!(
        connection,
        "select count(*) from sync_screen_share_leases where tenant_id = $1 and episode_id = $2",
        episode_ids(fixture)
      ).rows

    count
  end
end
