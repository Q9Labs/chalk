defmodule ChalkSync.Chat.AppendAttachmentsPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Chat.Repository.Postgres, as: Repository
  alias ChalkSync.Chat.Repository.SQL
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 3)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections), connections: connections}
  end

  setup %{connection: connection} do
    fixture = SyncPostgres.seed_episode(connection, 1)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, fixture: fixture}
  end

  test "two expiring sources in one send lock by attachment id and preserve input order", %{
    connection: connection,
    connections: connections,
    fixture: fixture
  } do
    [sender] = fixture.identities

    Postgrex.query!(
      connection,
      "insert into sync_chat_streams(tenant_id,space_id) values($1,$2)",
      [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.space_id)]
    )

    first = insert_attachment(connection, fixture, sender, "first-expiring-source")
    second = insert_attachment(connection, fixture, sender, "second-expiring-source")
    [lower, higher] = Enum.sort([first, second])
    input_order = [higher, lower]
    parent = self()

    assert SQL.lock_attachments() =~ "order by tenant_id, space_id, attachment_id"

    lock_connection = Enum.at(connections, 1)

    blocker =
      Task.async(fn ->
        Postgrex.transaction(lock_connection, fn transaction ->
          Postgrex.query!(
            transaction,
            "select attachment_id from sync_chat_attachments where tenant_id = $1 and space_id = $2 and attachment_id = $3 for update",
            [
              UUID.dump!(fixture.episode.tenant_id),
              UUID.dump!(fixture.episode.space_id),
              UUID.dump!(lower)
            ]
          )

          send(parent, :lower_attachment_locked)

          receive do
            :release_lower_attachment -> :ok
          end
        end)
      end)

    assert_receive :lower_attachment_locked, 2_000

    append =
      Task.async(fn ->
        Process.put(:sync_test_transaction, Enum.at(connections, 2))

        Repository.append(sender, %{
          client_message_id: "two-expiring-sources-0001",
          text: "",
          attachment_ids: input_order,
          attachment_commit_observer: fn ->
            send(parent, :append_before_attachment_lock)

            receive do
              :continue_attachment_lock -> :ok
            end
          end
        })
      end)

    assert_receive :append_before_attachment_lock, 2_000
    send(append.pid, :continue_attachment_lock)
    wait_for_attachment_lock_wait(connection, 100)

    # If input order still controlled locking, the append would lock `higher` before
    # blocking on `lower`. The fixed key order blocks on `lower` first, so `higher`
    # remains available here.
    assert [[_id]] =
             Postgrex.query!(
               connection,
               "select attachment_id from sync_chat_attachments where tenant_id = $1 and space_id = $2 and attachment_id = $3 for update nowait",
               [
                 UUID.dump!(fixture.episode.tenant_id),
                 UUID.dump!(fixture.episode.space_id),
                 UUID.dump!(higher)
               ]
             ).rows

    wait_until_sources_expire(connection, fixture, 100)
    send(blocker.pid, :release_lower_attachment)

    assert {:ok, %{message: message}} = Task.await(append, 5_000)
    assert Task.await(blocker, 2_000)
    assert Enum.map(message.attachments, & &1.attachment_id) == input_order

    rows =
      Postgrex.query!(
        connection,
        """
        select attachment_id, message_ordinal
        from sync_chat_attachments
        where tenant_id = $1 and space_id = $2 and status = 'attached'
        order by message_ordinal
        """,
        [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.space_id)]
      ).rows

    assert Enum.map(rows, fn [attachment_id, _ordinal] -> UUID.load!(attachment_id) end) ==
             input_order
  end

  defp wait_until_sources_expire(_connection, _fixture, 0),
    do: flunk("source attachments did not expire during the send")

  defp wait_until_sources_expire(connection, fixture, attempts) do
    [[unexpired]] =
      Postgrex.query!(
        connection,
        """
        select count(*) from sync_chat_attachments
        where tenant_id = $1 and space_id = $2 and expires_at > clock_timestamp()
        """,
        [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.space_id)]
      ).rows

    if unexpired == 0 do
      :ok
    else
      Process.sleep(10)
      wait_until_sources_expire(connection, fixture, attempts - 1)
    end
  end

  defp wait_for_attachment_lock_wait(_connection, 0),
    do: flunk("append did not wait for the lower attachment lock")

  defp wait_for_attachment_lock_wait(connection, attempts) do
    waiting =
      Postgrex.query!(
        connection,
        """
        select count(*) from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query like '%from sync_chat_attachments%'
        """,
        []
      ).rows

    case waiting do
      [[count]] when count > 0 ->
        :ok

      _ ->
        Process.sleep(10)
        wait_for_attachment_lock_wait(connection, attempts - 1)
    end
  end

  defp insert_attachment(connection, fixture, sender, client_attachment_id) do
    attachment_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_attachments(
        tenant_id,space_id,episode_id,attachment_id,participant_id,participant_generation,
        client_attachment_id,request_fingerprint,upload_id,object_key,original_filename,
        mime_type,byte_length,sha256,immutable_object_identity,status,expires_at,finalized_at
      ) values(
        $1,$2,$3,$4,$5,$6,$7,repeat('a',32)::bytea,gen_random_uuid(),
        'object-' || gen_random_uuid()::text,'deck.pdf','application/pdf',1024,repeat('b',32)::bytea,
        'object-version','ready',now()+interval '300 milliseconds',now()
      )
      """,
      [
        UUID.dump!(fixture.episode.tenant_id),
        UUID.dump!(fixture.episode.space_id),
        UUID.dump!(fixture.episode.episode_id),
        UUID.dump!(attachment_id),
        UUID.dump!(sender.participant_id),
        sender.participant_generation,
        client_attachment_id
      ]
    )

    attachment_id
  end
end
