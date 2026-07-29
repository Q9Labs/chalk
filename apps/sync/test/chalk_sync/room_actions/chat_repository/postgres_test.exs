defmodule ChalkSync.RoomActions.ChatRepository.PostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.RoomActions.ChatRepository.Postgres
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
    fixture = SyncPostgres.seed_session(hd(connections))
    connection = hd(connections)
    identity = hd(fixture.identities)

    Postgrex.query!(
      connection,
      """
      update participants
      set capabilities = array['sendReaction', 'sendChat']
      where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
      """,
      [
        uuid(identity.session.tenant_id),
        uuid(identity.session.room_id),
        uuid(identity.session.session_id),
        uuid(identity.participant_session_id)
      ]
    )

    identity = %{identity | capabilities: ["sendReaction", "sendChat"]}

    on_exit(fn ->
      cleanup_chat(connection, identity.session)
      SyncPostgres.cleanup(connection, identity.session)
    end)

    {:ok, connection: connection, identity: identity}
  end

  test "allocates contiguous sequences and returns stable idempotent results", %{
    identity: identity
  } do
    input = %{client_message_id: "chat-message-0001", text: "First message"}

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
               text: "Second message"
             })

    assert second.sequence == "2"

    assert {:ok, %{head_sequence: "2", retained_floor_sequence: "1"}} =
             Postgres.head(identity.session)
  end

  test "serializes concurrent sends without gaps", %{identity: identity} do
    results =
      1..24
      |> Task.async_stream(
        fn index ->
          Postgres.append(identity, %{
            client_message_id: "chat-concurrent-#{String.pad_leading(to_string(index), 4, "0")}",
            text: "message #{index}"
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
                 text: "message #{index}"
               })
    end)

    assert {:ok, first_page} =
             Postgres.read_page(identity.session, %{
               direction: :newer,
               cursor_sequence: nil,
               limit: 10
             })

    assert Enum.map(first_page.messages, & &1.sequence) == Enum.map(1..10, &to_string/1)
    assert first_page.has_more

    assert {:ok, older_page} =
             Postgres.read_page(identity.session, %{
               direction: :older,
               cursor_sequence: nil,
               limit: 5
             })

    assert Enum.map(older_page.messages, & &1.sequence) == Enum.map(8..12, &to_string/1)
    assert older_page.has_more

    retain_from(connection, identity.session, 5)

    assert {:cursor_reset, "5"} =
             Postgres.read_page(identity.session, %{
               direction: :newer,
               cursor_sequence: "2",
               limit: 10
             })
  end

  test "fences stale participants and ended Sessions", %{
    connection: connection,
    identity: identity
  } do
    committed_input = %{
      client_message_id: "chat-before-end-01",
      text: "accepted before end"
    }

    assert {:ok, %{outcome: :committed, message: committed}} =
             Postgres.append(identity, committed_input)

    stale = %{identity | participant_session_generation: 2}

    assert {:error, :participant_stale} =
             Postgres.append(stale, %{
               client_message_id: "chat-stale-gen-01",
               text: "not accepted"
             })

    Postgrex.query!(
      connection,
      "update room_sessions set status = 'ending' where tenant_id = $1 and id = $2",
      [uuid(identity.session.tenant_id), uuid(identity.session.session_id)]
    )

    assert {:ok, %{outcome: :duplicate, message: ^committed}} =
             Postgres.append(identity, committed_input)

    assert {:error, :session_ended} =
             Postgres.append(identity, %{
               client_message_id: "chat-ended-room-01",
               text: "not accepted"
             })
  end

  defp retain_from(connection, session, floor) do
    Postgrex.transaction(connection, fn transaction ->
      Postgrex.query!(
        transaction,
        """
        delete from sync_chat_messages
        where tenant_id = $1 and session_id = $2 and sequence < $3
        """,
        [uuid(session.tenant_id), uuid(session.session_id), floor]
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
              and message.session_id = stream.session_id
          ), 0)
        where tenant_id = $1 and session_id = $2
        """,
        [uuid(session.tenant_id), uuid(session.session_id), floor]
      )
    end)
  end

  defp cleanup_chat(connection, session) do
    Postgrex.query!(
      connection,
      "delete from sync_chat_messages where tenant_id = $1 and session_id = $2",
      [uuid(session.tenant_id), uuid(session.session_id)]
    )

    Postgrex.query!(
      connection,
      "delete from sync_chat_streams where tenant_id = $1 and session_id = $2",
      [uuid(session.tenant_id), uuid(session.session_id)]
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
