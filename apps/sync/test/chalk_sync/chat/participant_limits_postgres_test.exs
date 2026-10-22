defmodule ChalkSync.Chat.ParticipantLimitsPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Admission
  alias ChalkSync.Chat
  alias ChalkSync.Chat.Repository.Postgres, as: Repository
  alias ChalkSync.Fanout.Collaboration
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 4)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    fixture =
      SyncPostgres.seed_episode(connection, 2, %{}, %{
        participants: [%{role: "owner"}, %{role: "collaborator"}]
      })

    on_exit(fn ->
      Application.delete_env(:chalk_sync, :chat_participant_limits)
      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    {:ok, fixture: fixture, fanout: start_supervised!({Collaboration, name: nil})}
  end

  test "one Participant's chat sends are rate limited without slowing another Participant",
       %{fixture: fixture, fanout: fanout} do
    [first, second] = fixture.identities
    admission = start_supervised!({Admission, name: nil, rate_max: [chat: 2]})
    options = [fanout: fanout, admission: admission]

    outcomes =
      for index <- 1..3 do
        {:ok, result} = Chat.send_chat(first, chat("rate-first-#{index}"), options)
        {result["outcome"], result["error_code"]}
      end

    assert outcomes == [{"accepted", nil}, {"accepted", nil}, {"rejected", "rate_limited"}]

    assert {:ok, %{"outcome" => "accepted"}} =
             Chat.send_chat(second, chat("rate-second-1"), options)
  end

  test "one Participant cannot fill the Space chat history past its message cap",
       %{fixture: fixture} do
    [first, second] = fixture.identities
    Application.put_env(:chalk_sync, :chat_participant_limits, %{messages: 2, bytes: 1_000_000})

    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("count-first-1"))
    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("count-first-2"))
    assert {:error, :rate_limited} = Repository.append(first, chat("count-first-3"))
    assert {:ok, %{outcome: :duplicate}} = Repository.append(first, chat("count-first-2"))
    assert {:ok, %{outcome: :committed}} = Repository.append(second, chat("count-second-1"))
  end

  test "a retry of a stored message gets its original result after the window is full",
       %{fixture: fixture, fanout: fanout} do
    [first, _second] = fixture.identities
    admission = start_supervised!({Admission, name: nil, rate_max: [chat: 1, chat_retry: 1]})
    options = [fanout: fanout, admission: admission]

    assert {:ok, %{"outcome" => "accepted", "message" => original}} =
             Chat.send_chat(first, chat("retry-first-1"), options)

    assert {:ok, %{"outcome" => "accepted", "message" => ^original}} =
             Chat.send_chat(first, chat("retry-first-1"), options)

    # The lookup window is now full too, so further retries are refused without a read.
    assert {:ok, %{"outcome" => "rejected", "error_code" => "rate_limited"}} =
             Chat.send_chat(first, chat("retry-first-1"), options)
  end

  test "a person who rejoins as a new participant keeps the same message cap",
       %{connection: connection, fixture: fixture} do
    [first, rejoined] = fixture.identities
    identity_id = UUID.generate()
    tenant_id = UUID.dump!(fixture.episode.tenant_id)

    Postgrex.query!(
      connection,
      "insert into identities (id, tenant_id, kind, external_id, display_name) values ($1, $2, 'user', $3, 'Ada')",
      [UUID.dump!(identity_id), tenant_id, "chat-limit-#{identity_id}"]
    )

    Postgrex.query!(
      connection,
      "update participants set identity_id = $2 where tenant_id = $1",
      [tenant_id, UUID.dump!(identity_id)]
    )

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

    Application.put_env(:chalk_sync, :chat_participant_limits, %{messages: 2, bytes: 1_000_000})

    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("rejoin-first-1"))
    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("rejoin-first-2"))
    assert {:error, :rate_limited} = Repository.append(rejoined, chat("rejoin-again-1"))
  end

  test "one Participant cannot fill the Space chat history past its byte cap",
       %{fixture: fixture} do
    [first, second] = fixture.identities
    Application.put_env(:chalk_sync, :chat_participant_limits, %{messages: 100, bytes: 1_500})
    long = String.duplicate("a", 600)

    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("bytes-first-1", long))
    assert {:error, :rate_limited} = Repository.append(first, chat("bytes-first-2", long))
    assert {:ok, %{outcome: :committed}} = Repository.append(second, chat("bytes-second-1", long))
  end

  defp chat(client_message_id, text \\ "Hello"),
    do: %{client_message_id: "#{client_message_id}-0000000000", text: text, attachment_ids: []}
end
