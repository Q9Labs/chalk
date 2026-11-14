defmodule ChalkSync.Chat.PersonLimitsRatePostgresTest do
  use ChalkSync.Chat.PersonLimitsCase, async: false

  alias ChalkSync.Chat
  alias ChalkSync.Chat.Repository.Postgres, as: Repository
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

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

  test "a send with a missing file fails without waiting for the Space stream lock",
       %{fixture: fixture} do
    [first, _second] = fixture.identities
    assert {:ok, %{outcome: :committed}} = Repository.append(first, chat("files-first-0"))

    # Another send holds the Space stream lock for as long as this test needs.
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
    missing = %{chat("files-first-1") | attachment_ids: [UUID.generate()]}
    send_with_missing_file = Task.async(fn -> Repository.append(first, missing) end)

    assert {:ok, {:error, :attachment_not_found}} = Task.yield(send_with_missing_file, 2_000)
    send(holder.pid, :release)
    Task.await(holder)
  end
end
