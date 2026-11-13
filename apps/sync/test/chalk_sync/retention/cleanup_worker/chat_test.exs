defmodule ChalkSync.Retention.CleanupWorkerChatTest do
  use ChalkSync.Retention.CleanupWorkerCase, async: false

  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.UUID

  @now ~U[2026-07-12 00:00:00.000000Z]
  @retention_seconds 7 * 24 * 60 * 60

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
end
