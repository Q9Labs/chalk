defmodule ChalkSync.Chat.Repository.PostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Chat.Repository.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

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

  setup %{connections: connections} do
    fixture = SyncPostgres.seed_episode(hd(connections))
    connection = hd(connections)
    identity = hd(fixture.identities)

    Postgrex.query!(
      connection,
      """
      update participants
      set capabilities = array['sendReaction', 'sendChat']
      where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4
      """,
      [
        uuid(identity.episode.tenant_id),
        uuid(identity.episode.space_id),
        uuid(identity.episode.episode_id),
        uuid(identity.participant_id)
      ]
    )

    identity = %{identity | capabilities: ["sendReaction", "sendChat"]}

    on_exit(fn ->
      cleanup_chat(connection, identity.episode)
      SyncPostgres.cleanup(connection, identity.episode)
    end)

    {:ok, connection: connection, identity: identity}
  end

  test "allocates contiguous sequences and returns stable idempotent results", %{
    identity: identity
  } do
    input = %{
      client_message_id: "chat-message-0001",
      text: "First message",
      attachment_ids: []
    }

    assert {:ok, %{outcome: :committed, message: first}} = Postgres.append(identity, input)
    assert first.sequence == "1"

    assert {:ok, %{outcome: :duplicate, message: duplicate}} =
             Postgres.append(identity, input)

    assert duplicate == first

    assert {:error, :client_message_id_conflict} =
             Postgres.append(identity, %{input | text: "Changed message"})

    assert {:ok, %{outcome: :committed, message: second}} =
             Postgres.append(identity, %{
               client_message_id: "chat-message-0002",
               text: "Second message",
               attachment_ids: []
             })

    assert second.sequence == "2"

    assert {:ok, %{head_sequence: "2", retained_floor_sequence: "1"}} =
             Postgres.head(identity.episode)
  end

  test "serializes concurrent sends without gaps", %{identity: identity} do
    results =
      1..24
      |> Task.async_stream(
        fn index ->
          Postgres.append(identity, %{
            client_message_id: "chat-concurrent-#{String.pad_leading(to_string(index), 4, "0")}",
            text: "message #{index}",
            attachment_ids: []
          })
        end,
        max_concurrency: 8,
        timeout: 10_000
      )
      |> Enum.map(fn {:ok, {:ok, result}} -> result end)

    sequences =
      results
      |> Enum.map(&String.to_integer(&1.message.sequence))
      |> Enum.sort()

    assert sequences == Enum.to_list(1..24)
  end

  test "returns bounded chronological pages and a reset below the retained floor", %{
    connection: connection,
    identity: identity
  } do
    Enum.each(1..12, fn index ->
      assert {:ok, %{outcome: :committed}} =
               Postgres.append(identity, %{
                 client_message_id:
                   "chat-page-item-#{String.pad_leading(to_string(index), 3, "0")}",
                 text: "message #{index}",
                 attachment_ids: []
               })
    end)

    assert {:ok, first_page} =
             Postgres.read_page(identity.episode, %{
               direction: :newer,
               cursor_sequence: nil,
               limit: 10
             })

    assert Enum.map(first_page.messages, & &1.sequence) == Enum.map(1..10, &to_string/1)
    assert first_page.has_more

    assert {:ok, older_page} =
             Postgres.read_page(identity.episode, %{
               direction: :older,
               cursor_sequence: nil,
               limit: 5
             })

    assert Enum.map(older_page.messages, & &1.sequence) == Enum.map(8..12, &to_string/1)
    assert older_page.has_more

    retain_from(connection, identity.episode, 5)

    assert {:cursor_reset, "5"} =
             Postgres.read_page(identity.episode, %{
               direction: :newer,
               cursor_sequence: "2",
               limit: 10
             })
  end

  test "fences stale participants and ended Episodes", %{
    connection: connection,
    identity: identity
  } do
    committed_input = %{
      client_message_id: "chat-before-end-01",
      text: "accepted before end",
      attachment_ids: []
    }

    assert {:ok, %{outcome: :committed, message: committed}} =
             Postgres.append(identity, committed_input)

    stale = %{identity | participant_generation: 2}

    assert {:error, :participant_stale} =
             Postgres.append(stale, %{
               client_message_id: "chat-stale-gen-01",
               text: "not accepted",
               attachment_ids: []
             })

    Postgrex.query!(
      connection,
      "update episodes set status = 'ending' where tenant_id = $1 and id = $2",
      [uuid(identity.episode.tenant_id), uuid(identity.episode.episode_id)]
    )

    assert {:ok, %{outcome: :duplicate, message: ^committed}} =
             Postgres.append(identity, committed_input)

    assert {:error, :episode_ended} =
             Postgres.append(identity, %{
               client_message_id: "chat-ended-space-01",
               text: "not accepted",
               attachment_ids: []
             })
  end

  test "atomically claims ready attachments and advances read watermarks", %{
    connection: connection,
    identity: identity
  } do
    attachment_id = UUID.generate()
    upload_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_streams (tenant_id, space_id)
      values ($1, $2)
      on conflict (tenant_id, space_id) do nothing
      """,
      [
        uuid(identity.episode.tenant_id),
        uuid(identity.episode.space_id)
      ]
    )

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_attachments (
        tenant_id, space_id, episode_id, attachment_id,
        participant_id, participant_generation,
        client_attachment_id, request_fingerprint, upload_id, object_key,
        original_filename, mime_type, byte_length, sha256,
        immutable_object_identity, status, expires_at, finalized_at
      ) values (
        $1, $2, $3, $4, $5, $6, 'chat-file-client-0001',
        $7, $8, $9, 'diagram.png', 'image/png', 32, $10,
        'immutable-etag', 'ready', now() + interval '1 day', now()
      )
      """,
      [
        uuid(identity.episode.tenant_id),
        uuid(identity.episode.space_id),
        uuid(identity.episode.episode_id),
        uuid(attachment_id),
        uuid(identity.participant_id),
        identity.participant_generation,
        :crypto.hash(:sha256, "reservation"),
        uuid(upload_id),
        "chat-attachments-v1/#{upload_id}",
        :crypto.hash(:sha256, "content")
      ]
    )

    assert {:ok, %{outcome: :committed, message: message}} =
             Postgres.append(identity, %{
               client_message_id: "chat-attachment-0001",
               text: "",
               attachment_ids: [attachment_id]
             })

    assert message.text == ""

    assert message.attachments == [
             %{
               attachment_id: attachment_id,
               file_name: "diagram.png",
               mime_type: "image/png",
               byte_length: 32
             }
           ]

    assert {:ok, %{outcome: :advanced, receipt: receipt}} =
             Postgres.mark_read(identity, "1")

    assert receipt.sequence == "1"
    assert receipt.participant_generation == identity.participant_generation

    assert {:ok, %{outcome: :unchanged, receipt: ^receipt}} =
             Postgres.mark_read(identity, "1")

    assert {:error, :invalid_payload} = Postgres.mark_read(identity, "2")
    assert {:ok, [^receipt]} = Postgres.read_receipts(identity.episode)
  end

  test "fences expired and cleanup-claimed attachments from message binding", %{
    connection: connection,
    identity: identity
  } do
    expired_attachment =
      insert_ready_attachment(
        connection,
        identity,
        DateTime.add(DateTime.utc_now(), -1, :second)
      )

    cleanup_token = UUID.generate()

    cleanup_claimed_attachment =
      insert_ready_attachment(
        connection,
        identity,
        DateTime.add(DateTime.utc_now(), 1, :day),
        cleanup_token
      )

    for {attachment_id, client_message_id} <- [
          {expired_attachment, "chat-expired-file-0001"},
          {cleanup_claimed_attachment, "chat-cleanup-file-0001"}
        ] do
      assert {:error, :attachment_not_found} =
               Postgres.append(identity, %{
                 client_message_id: client_message_id,
                 text: "",
                 attachment_ids: [attachment_id]
               })
    end

    assert [["ready", persisted_cleanup_token]] =
             Postgrex.query!(
               connection,
               """
               select status, cleanup_claim_token
               from sync_chat_attachments
               where tenant_id = $1 and episode_id = $2 and attachment_id = $3
               """,
               [
                 uuid(identity.episode.tenant_id),
                 uuid(identity.episode.episode_id),
                 uuid(cleanup_claimed_attachment)
               ]
             ).rows

    assert UUID.load!(persisted_cleanup_token) == cleanup_token
  end

  test "returns at most 500 deterministic active-participant read receipts", %{
    connection: connection,
    identity: identity
  } do
    assert {:ok, %{outcome: :committed}} =
             Postgres.append(identity, %{
               client_message_id: "chat-receipt-bound-0001",
               text: "receipt bound seed",
               attachment_ids: []
             })

    params = [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id)
    ]

    Postgrex.query!(
      connection,
      """
      with readers as (
        select
          (
            '10000000-0000-4000-8000-' ||
            substr(replace(($3::uuid)::text, '-', ''), 1, 8) ||
            lpad(reader_index::text, 4, '0')
          )::uuid as participant_id,
          reader_index
        from generate_series(1, 501) as reader_index
      )
      insert into participants (
        id, name, capabilities, tenant_id, space_id, episode_id,
        generation, status, joined_at, role
      )
      select
        participant_id,
        'Reader ' || reader_index,
        array['sendChat']::text[],
        $1,
        $2,
       $3::uuid,
        1,
        'active',
        now(),
        'observer'
      from readers
      """,
      params
    )

    Postgrex.query!(
      connection,
      """
      with readers as (
        select
          (
            '10000000-0000-4000-8000-' ||
            substr(replace(($3::uuid)::text, '-', ''), 1, 8) ||
            lpad(reader_index::text, 4, '0')
          )::uuid as participant_id,
          reader_index
        from generate_series(1, 501) as reader_index
      )
      insert into sync_chat_read_receipts (
        tenant_id, space_id, episode_id, participant_id,
        participant_generation, sequence, read_at
      )
      select
        $1,
        $2,
        $3,
        participant_id,
        1,
        1,
        '2026-07-30T00:00:00Z'::timestamptz +
          reader_index * interval '1 millisecond'
      from readers
      """,
      params
    )

    assert {:ok, receipts} = Postgres.read_receipts(identity.episode)
    assert length(receipts) == 500
    assert String.ends_with?(hd(receipts).participant_id, "0501")
    assert String.ends_with?(List.last(receipts).participant_id, "0002")
    refute Enum.any?(receipts, &(&1.participant_id == reader_id(1)))
  end

  defp insert_ready_attachment(
         connection,
         identity,
         expires_at,
         cleanup_token \\ nil
       ) do
    attachment_id = UUID.generate()
    upload_id = UUID.generate()
    cleanup_until = if cleanup_token, do: DateTime.add(DateTime.utc_now(), 5, :minute)

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_streams (tenant_id, space_id)
      values ($1, $2)
      on conflict (tenant_id, space_id) do nothing
      """,
      [
        uuid(identity.episode.tenant_id),
        uuid(identity.episode.space_id)
      ]
    )

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_attachments (
        tenant_id, space_id, episode_id, attachment_id,
        participant_id, participant_generation,
        client_attachment_id, request_fingerprint, upload_id, object_key,
        original_filename, mime_type, byte_length, sha256,
        immutable_object_identity, status, expires_at, finalized_at,
        cleanup_claim_token, cleanup_claimed_until
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        'diagram.png', 'image/png', 32, $11,
        'immutable-etag', 'ready', $12, now(), $13, $14
      )
      """,
      [
        uuid(identity.episode.tenant_id),
        uuid(identity.episode.space_id),
        uuid(identity.episode.episode_id),
        uuid(attachment_id),
        uuid(identity.participant_id),
        identity.participant_generation,
        "chat-file-#{attachment_id}",
        :crypto.hash(:sha256, "reservation"),
        uuid(upload_id),
        "chat-attachments-v1/#{upload_id}",
        :crypto.hash(:sha256, "content"),
        expires_at,
        if(cleanup_token, do: uuid(cleanup_token)),
        cleanup_until
      ]
    )

    attachment_id
  end

  defp reader_id(index) do
    "10000000-0000-4000-8000-" <> String.pad_leading(Integer.to_string(index), 12, "0")
  end

  defp retain_from(connection, episode, floor) do
    Postgrex.transaction(connection, fn transaction ->
      Postgrex.query!(
        transaction,
        """
        delete from sync_chat_messages
        where tenant_id = $1 and space_id = $2 and sequence < $3
        """,
        [uuid(episode.tenant_id), uuid(episode.space_id), floor]
      )

      Postgrex.query!(
        transaction,
        """
        update sync_chat_streams stream
        set
          retained_floor_sequence = $3,
          message_count = stream.head_sequence - $3 + 1,
          message_bytes = coalesce((
            select sum(message.encoded_bytes)
            from sync_chat_messages message
            where message.tenant_id = stream.tenant_id
              and message.space_id = stream.space_id
          ), 0)
        where tenant_id = $1 and space_id = $2
        """,
        [uuid(episode.tenant_id), uuid(episode.space_id), floor]
      )
    end)
  end

  defp cleanup_chat(connection, episode) do
    Postgrex.query!(
      connection,
      "delete from sync_chat_read_receipts where tenant_id = $1 and episode_id = $2",
      [uuid(episode.tenant_id), uuid(episode.episode_id)]
    )

    Postgrex.query!(
      connection,
      "delete from sync_chat_attachments where tenant_id = $1 and episode_id = $2",
      [uuid(episode.tenant_id), uuid(episode.episode_id)]
    )

    Postgrex.query!(
      connection,
      "delete from sync_chat_messages where tenant_id = $1 and episode_id = $2",
      [uuid(episode.tenant_id), uuid(episode.episode_id)]
    )

    Postgrex.query!(
      connection,
      "delete from sync_chat_streams where tenant_id = $1 and space_id = $2",
      [uuid(episode.tenant_id), uuid(episode.space_id)]
    )
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end

  defp uuid(value), do: UUID.dump!(value)
end
