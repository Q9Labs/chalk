defmodule ChalkSync.Chat.PersonLimitsCapsPostgresTest do
  use ChalkSync.Chat.PersonLimitsCase, async: false

  alias ChalkSync.Chat.Repository.Postgres, as: Repository
  alias ChalkSync.UUID

  test "a retry with a file that commits while the retry waits gets the original message",
       %{connection: connection, fixture: fixture} do
    [first, _second] = fixture.identities
    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("file-retry-0"))
    attachment_id = ready_attachment(connection, first)
    input = %{chat("file-retry-1") | attachment_ids: [attachment_id]}
    test = self()

    # The retry stops after its first duplicate lookup, just before the early checks.
    paused = fn ->
      send(test, :retry_paused)
      receive do: (:check -> :ok)
    end

    # The retry runs on another Sync node, so it has its own database connection.
    retry =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)
        Repository.append(first, Map.put(input, :early_check_observer, paused))
      end)

    assert_receive :retry_paused
    assert {:ok, %{outcome: :committed, message: message}} = Repository.append(first, input)
    send(retry.pid, :check)

    assert {:ok, %{outcome: :duplicate, message: ^message}} = Task.await(retry)
  end

  test "a retry whose original fills the window while the retry waits gets the original message",
       %{fixture: fixture} do
    [first, _second] = fixture.identities
    limit(window_messages: 1)
    input = chat("window-retry-1")
    test = self()

    # The retry stops after its first duplicate lookup, just before the early checks.
    paused = fn ->
      send(test, :retry_paused)
      receive do: (:check -> :ok)
    end

    # The retry runs on another Sync node, so it has its own database connection.
    retry =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)
        Repository.append(first, Map.put(input, :early_check_observer, paused))
      end)

    assert_receive :retry_paused
    assert {:ok, %{outcome: :committed, message: message}} = Repository.append(first, input)
    send(retry.pid, :check)

    assert {:ok, %{outcome: :duplicate, message: ^message}} = Task.await(retry)
  end

  test "a person who rejoins as a new participant keeps the same rate window",
       %{connection: connection, fixture: fixture} do
    [first, rejoined] = same_person(connection, fixture)
    limit(window_messages: 2)

    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("rejoin-rate-1"))
    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("rejoin-rate-2"))
    assert {:error, :rate_limited} = Repository.append(rejoined, chat("rejoin-rate-3"))
  end

  test "sends from a seat that may no longer chat do not spend the person's window",
       %{connection: connection, fixture: fixture} do
    [stale, current] = same_person(connection, fixture)
    limit(window_messages: 1)

    Postgrex.query!(
      connection,
      "update participants set status = 'left', left_at = now(), last_left_reason = 'left' where id = $1",
      [UUID.dump!(stale.participant_id)]
    )

    for index <- 1..3 do
      assert {:error, reason} = Repository.append(stale, chat("stale-seat-#{index}"))
      refute reason == :rate_limited
    end

    assert {:ok, %{outcome: :committed}} = Repository.append(current, chat("current-seat-1"))
  end

  test "a person who rejoins as a new participant keeps the same message cap",
       %{connection: connection, fixture: fixture} do
    [first, rejoined] = same_person(connection, fixture)
    limit(messages: 2)

    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("rejoin-cap-1"))
    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("rejoin-cap-2"))
    assert {:error, :rate_limited} = Repository.append(rejoined, chat("rejoin-cap-3"))
  end

  test "one person cannot fill the Space chat history past the message cap",
       %{fixture: fixture} do
    [first, second] = fixture.identities
    limit(messages: 2)

    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("count-first-1"))
    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("count-first-2"))
    assert {:error, :rate_limited} = Repository.append(first, chat("count-first-3"))
    assert {:ok, %{outcome: :duplicate}} = Repository.append(first, chat("count-first-2"))
    assert {:ok, %{outcome: :committed}} = Repository.append(second, chat("count-second-1"))
  end

  test "one person cannot fill the Space chat history past the byte cap",
       %{fixture: fixture} do
    [first, second] = fixture.identities
    limit(bytes: 1_500)
    long = String.duplicate("a", 600)

    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("bytes-first-1", long))
    assert {:error, :rate_limited} = Repository.append(first, chat("bytes-first-2", long))
    assert {:ok, %{outcome: :committed}} = Repository.append(second, chat("bytes-second-1", long))
  end

  # Both seeded participants become one API identity, the way a rejoin creates a second row.
  defp same_person(connection, fixture) do
    identity_id = UUID.generate()
    tenant_id = UUID.dump!(fixture.episode.tenant_id)

    Postgrex.query!(
      connection,
      "insert into identities (id, tenant_id, kind, external_id, display_name) values ($1, $2, 'user', $3, 'Ada')",
      [UUID.dump!(identity_id), tenant_id, "chat-limit-#{identity_id}"]
    )

    Postgrex.query!(connection, "update participants set identity_id = $2 where tenant_id = $1", [
      tenant_id,
      UUID.dump!(identity_id)
    ])

    on_exit(fn ->
      Postgrex.query!(
        connection,
        "update participants set identity_id = null where tenant_id = $1",
        [
          tenant_id
        ]
      )

      Postgrex.query!(connection, "delete from identities where tenant_id = $1", [tenant_id])
    end)

    fixture.identities
  end

  defp ready_attachment(connection, identity) do
    attachment_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into sync_chat_attachments (
        tenant_id, space_id, episode_id, attachment_id, participant_id, participant_generation,
        client_attachment_id, request_fingerprint, upload_id, object_key, original_filename,
        mime_type, byte_length, sha256, immutable_object_identity, finalized_at, status, expires_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, sha256(convert_to($7::text, 'UTF8')), $8, $7, 'notes.txt', 'text/plain',
        5, sha256('notes'), 'etag-1', now(), 'ready', now() + interval '1 hour')
      """,
      [
        UUID.dump!(identity.episode.tenant_id),
        UUID.dump!(identity.episode.space_id),
        UUID.dump!(identity.episode.episode_id),
        UUID.dump!(attachment_id),
        UUID.dump!(identity.participant_id),
        identity.participant_generation,
        "file-#{attachment_id}",
        UUID.dump!(UUID.generate())
      ]
    )

    attachment_id
  end
end
