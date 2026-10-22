defmodule ChalkSync.Chat.PersonLimitsPostgresTest do
  use ExUnit.Case, async: false

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
      Application.delete_env(:chalk_sync, :chat_person_limits)
      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    {:ok, fixture: fixture, fanout: start_supervised!({Collaboration, name: nil})}
  end

  test "one person's chat sends are rate limited without slowing another person",
       %{fixture: fixture, fanout: fanout} do
    [first, second] = fixture.identities
    limit(window_messages: 2)

    outcomes =
      for index <- 1..3 do
        {:ok, result} = Chat.send_chat(first, chat("rate-first-#{index}"), fanout: fanout)
        {result["outcome"], result["error_code"]}
      end

    assert outcomes == [{"accepted", nil}, {"accepted", nil}, {"rejected", "rate_limited"}]

    assert {:ok, %{"outcome" => "accepted"}} =
             Chat.send_chat(second, chat("rate-second-1"), fanout: fanout)
  end

  test "a retry of a stored message gets its original result when the window is full",
       %{fixture: fixture, fanout: fanout} do
    [first, _second] = fixture.identities
    limit(window_messages: 1)

    assert {:ok, %{"outcome" => "accepted", "message" => original}} =
             Chat.send_chat(first, chat("retry-first-1"), fanout: fanout)

    assert {:ok, %{"outcome" => "rejected", "error_code" => "rate_limited"}} =
             Chat.send_chat(first, chat("retry-first-2"), fanout: fanout)

    assert {:ok, %{"outcome" => "accepted", "message" => ^original}} =
             Chat.send_chat(first, chat("retry-first-1"), fanout: fanout)
  end

  test "sends racing from two Sync nodes cannot pass the window together",
       %{fixture: fixture} do
    [first, _second] = fixture.identities
    limit(window_messages: 2)
    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("race-first-0"))

    # Hold the Space stream lock so both sends pass the early check before either commits.
    # Linked to the test process, so it closes with it.
    [blocker] = SyncPostgres.start_connections(@database_url, 1)
    test = self()

    holder =
      Task.async(fn ->
        Postgrex.transaction(blocker, fn locked ->
          Postgrex.query!(
            locked,
            "select 1 from sync_chat_streams where tenant_id = $1 and space_id = $2 for update",
            [UUID.dump!(first.episode.tenant_id), UUID.dump!(first.episode.space_id)]
          )

          send(test, :locked)
          receive do: (:release -> :ok)
        end)
      end)

    assert_receive :locked

    racers =
      for {node, index} <- [first: 1, second: 2] do
        Task.async(fn ->
          Process.put(:sync_test_node, node)
          Repository.append(first, chat("race-first-#{index}"))
        end)
      end

    Process.sleep(300)
    send(holder.pid, :release)
    Task.await(holder)
    outcomes = racers |> Task.await_many() |> Enum.map(&elem(&1, 0)) |> Enum.sort()

    assert outcomes == [:error, :ok]
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

  defp limit(limits), do: Application.put_env(:chalk_sync, :chat_person_limits, Map.new(limits))

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

  defp chat(client_message_id, text \\ "Hello"),
    do: %{client_message_id: "#{client_message_id}-0000000000", text: text, attachment_ids: []}
end
