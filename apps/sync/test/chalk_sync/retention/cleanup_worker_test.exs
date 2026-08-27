defmodule ChalkSync.Retention.CleanupWorkerTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Retention.CleanupWorker
  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  @now ~U[2026-07-12 00:00:00.000000Z]
  @retention_seconds 7 * 24 * 60 * 60

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  test "rolls back when the independent fold detects corruption", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_control_events set resulting_state_digest = decode(repeat('01', 32), 'hex') where tenant_id = $1 and episode_id = $2 and revision = 1",
      episode_ids(fixture)
    )

    assert {:error, {:invalid_history, :event_digest_mismatch}} = run_cleanup(connection)
    assert [events, intents] = history_counts(connection, fixture)
    assert events > 0
    assert intents > 0
    refute checkpointed?(connection, fixture)
  end

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

  test "serializes chat stream reconciliation with a concurrent append", %{
    connections: [cleanup_connection, append_connection | _connections]
  } do
    fixture = seed_ended_episode(cleanup_connection, @retention_seconds + 1)
    cleanup_fixture(cleanup_connection, fixture)
    seed_chat_rows(cleanup_connection, fixture)
    newer = seed_shared_episode(cleanup_connection, fixture)
    parent = self()

    append =
      Task.async(fn ->
        Postgrex.transaction(append_connection, fn transaction ->
          Postgrex.query!(
            transaction,
            "select head_sequence from sync_chat_streams where tenant_id = $1 and space_id = $2 for update",
            space_scope(fixture)
          )

          send(parent, :chat_stream_locked)

          receive do
            :append -> seed_newer_chat_row(transaction, newer)
          end
        end)
      end)

    assert_receive :chat_stream_locked
    cleanup = Task.async(fn -> run_cleanup(cleanup_connection) end)
    assert Task.yield(cleanup, 100) == nil

    send(append.pid, :append)
    assert {:ok, %Postgrex.Result{num_rows: 1}} = Task.await(append)
    assert {:ok, %Result{episodes: 1}} = Task.await(cleanup)

    assert chat_stream_state(cleanup_connection, fixture) == [2, 2, 1, 256]

    assert [[1]] =
             Postgrex.query!(
               cleanup_connection,
               "select count(*) from sync_chat_messages where tenant_id = $1 and episode_id = $2",
               [UUID.dump!(newer.tenant_id), UUID.dump!(newer.episode_id)]
             ).rows
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

  defp seed_ended_episode(connection, age_seconds) do
    fixture = SyncPostgres.seed_pending_join(connection)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert {:ok, operation} = Operation.new("retention_episode_end", :end_episode, %{})

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(fixture.identity, operation)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               operation_id,
               {:applied, :episode_ended, %{"reason" => "ended_by_participant"}}
             )

    age_ended_episode(connection, fixture, age_seconds)

    fixture
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

  defp seed_chat_rows(connection, fixture) do
    scope = episode_scope(fixture)
    participant_id = UUID.dump!(fixture.identity.participant_id)

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_streams (
        tenant_id, space_id, head_sequence, retained_floor_sequence,
        message_count, message_bytes
      ) values ($1, $2, 1, 1, 1, 128)
      """,
      Enum.take(scope, 2)
    )

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_messages (
        tenant_id, space_id, episode_id, sequence, message_id,
        participant_id, participant_generation,
        client_message_id, request_fingerprint, display_name, message_text,
        encoded_bytes, created_at
      ) values (
        $1, $2, $3, 1, $4, $5, $6, 'client-message-01',
        decode(repeat('02', 32), 'hex'), 'Ada', 'hello', 128, $7
      )
      """,
      scope ++
        [
          UUID.dump!(UUID.generate()),
          participant_id,
          fixture.identity.participant_generation,
          @now
        ]
    )
  end

  defp seed_shared_episode(connection, fixture) do
    episode_id = UUID.generate()
    participant_id = UUID.generate()
    role_capabilities = Reducer.new(episode_id).role_capabilities

    episode = %{
      tenant_id: fixture.episode.tenant_id,
      space_id: fixture.episode.space_id,
      episode_id: episode_id
    }

    Postgrex.query!(
      connection,
      """
      insert into episodes (id, status, space_id, tenant_id, started_at, config_snapshot)
      values ($1, 'active', $2, $3, $4, $5)
      """,
      [
        UUID.dump!(episode_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.tenant_id),
        @now,
        %{
          "roles" => role_capabilities,
          "admission_policy" => %{"mode" => "open"},
          "default_episode_duration_seconds" => 86_400,
          "maximum_episode_duration_seconds" => 86_400
        }
      ]
    )

    Postgrex.query!(
      connection,
      """
      insert into participants (
        id, name, capabilities, tenant_id, space_id, episode_id,
        generation, status, joined_at, role
      ) values ($1, 'Newer Participant', $2, $3, $4, $5, 1, 'active', $6, 'owner')
      """,
      [
        UUID.dump!(participant_id),
        role_capabilities["owner"],
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.episode_id),
        @now
      ]
    )

    Map.put(episode, :participant_id, participant_id)
  end

  defp seed_newer_chat_row(connection, newer) do
    scope = [
      UUID.dump!(newer.tenant_id),
      UUID.dump!(newer.space_id),
      UUID.dump!(newer.episode_id)
    ]

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_messages (
        tenant_id, space_id, episode_id, sequence, message_id,
        participant_id, participant_generation,
        client_message_id, request_fingerprint, display_name, message_text,
        encoded_bytes, created_at
      ) values (
        $1, $2, $3, 2, $4, $5, 1, 'client-message-02',
        decode(repeat('04', 32), 'hex'), 'Grace', 'newer', 256, $6
      )
      """,
      scope ++ [UUID.dump!(UUID.generate()), UUID.dump!(newer.participant_id), @now]
    )

    Postgrex.query!(
      connection,
      """
      update sync_chat_streams
      set head_sequence = 2, retained_floor_sequence = 1,
          message_count = 2, message_bytes = 384
      where tenant_id = $1 and space_id = $2
      """,
      Enum.take(scope, 2)
    )
  end

  defp synchronize_event_counters(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update sync_episode_control control
      set participant_event_count = event.participant_count,
          participant_event_bytes = event.participant_bytes,
          lifecycle_event_count = event.lifecycle_count,
          lifecycle_event_bytes = event.lifecycle_bytes
      from (
        select
          count(*) filter (where lifecycle_intent_id is null) as participant_count,
          coalesce(sum(encoded_bytes) filter (where lifecycle_intent_id is null), 0) as participant_bytes,
          count(*) filter (where lifecycle_intent_id is not null) as lifecycle_count,
          coalesce(sum(encoded_bytes) filter (where lifecycle_intent_id is not null), 0) as lifecycle_bytes
        from sync_control_events
        where tenant_id = $1 and episode_id = $2
      ) event
      where control.tenant_id = $1 and control.episode_id = $2
      """,
      episode_ids(fixture)
    )
  end

  defp age_ended_episode(connection, fixture, age_seconds) do
    ended_at = DateTime.add(@now, -age_seconds, :second)

    Postgrex.query!(
      connection,
      "update episodes set ended_at = $3 where tenant_id = $1 and id = $2",
      episode_ids(fixture) ++ [ended_at]
    )
  end

  defp operation(request_key, name, payload) do
    {:ok, operation} = Operation.new(request_key, name, payload)
    operation
  end

  defp run_cleanup(connection, options \\ []) do
    CleanupWorker.run_once(connection, Keyword.put(options, :clock, fn -> @now end))
  end

  defp history_counts(connection, fixture) do
    [[events, intents]] =
      Postgrex.query!(
        connection,
        """
        select
          (select count(*) from sync_control_events where tenant_id = $1 and episode_id = $2),
          (select count(*) from sync_lifecycle_intents where tenant_id = $1 and episode_id = $2)
        """,
        episode_ids(fixture)
      ).rows

    [events, intents]
  end

  defp cleaned_at(connection, fixture) do
    Postgrex.query!(
      connection,
      "select retention_cleaned_at from sync_episode_control where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
    ).rows
  end

  defp chat_stream_state(connection, fixture) do
    [[head, floor, count, bytes]] =
      Postgrex.query!(
        connection,
        """
        select head_sequence, retained_floor_sequence, message_count, message_bytes
        from sync_chat_streams where tenant_id = $1 and space_id = $2
        """,
        space_scope(fixture)
      ).rows

    [head, floor, count, bytes]
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

  defp checkpointed?(connection, fixture), do: cleaned_at(connection, fixture) != [[nil]]

  defp cleanup_fixture(connection, fixture) do
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
  end

  defp episode_ids(fixture),
    do: [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.episode_id)]

  defp episode_scope(fixture),
    do: [
      UUID.dump!(fixture.episode.tenant_id),
      UUID.dump!(fixture.episode.space_id),
      UUID.dump!(fixture.episode.episode_id)
    ]

  defp space_scope(fixture),
    do: [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.space_id)]

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
