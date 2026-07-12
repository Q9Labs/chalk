defmodule ChalkSync.Transport.OutboundQueueTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Transport.OutboundQueue

  test "preserves FIFO encoded frames and their revision metadata" do
    queue = queue_at(100)

    assert :ok = OutboundQueue.push(queue, "first", revision: 41, state_digest: "digest-41")

    assert :ok =
             OutboundQueue.push(queue, "second",
               revision: 42,
               state_digest: "digest-42",
               replay_page?: true
             )

    assert {:ok, %{encoded: "first", revision: 41, replay_page?: false, enqueued_at_ms: 100}} =
             OutboundQueue.peek(queue)

    assert {:ok, %{encoded: "first", revision: 41}} = OutboundQueue.pop(queue)

    assert {:ok, %{encoded: "second", revision: 42, replay_page?: true}} =
             OutboundQueue.pop(queue)

    assert :empty = OutboundQueue.pop(queue)

    assert {:ok, %{queued_events: 2, unsent_events: 0, in_flight_events: 2}} =
             OutboundQueue.stats(queue)

    assert {:ok, %{queued_events: 0, queued_bytes: 0}} =
             OutboundQueue.ack(queue, 42, "digest-42")
  end

  test "accounts for bytes, replay pages, and the oldest queued age" do
    {queue, clock} = queue_with_clock(100)

    assert :ok =
             OutboundQueue.push(queue, "abc",
               revision: 1,
               state_digest: "digest-1",
               replay_page?: true
             )

    advance(clock, 25)
    assert :ok = OutboundQueue.push(queue, "de", revision: 2, state_digest: "digest-2")

    assert {:ok, %{queued_events: 2, queued_bytes: 5, queued_replay_pages: 1, oldest_age_ms: 25}} =
             OutboundQueue.stats(queue)

    assert {:ok, %{encoded: "abc"}} = OutboundQueue.pop(queue)

    assert {:ok, %{queued_events: 2, unsent_events: 1, in_flight_events: 1}} =
             OutboundQueue.stats(queue)

    assert {:ok, _stats} = OutboundQueue.ack(queue, 1, "digest-1")

    assert {:ok, %{queued_events: 1, queued_bytes: 2, queued_replay_pages: 0, oldest_age_ms: 0}} =
             OutboundQueue.stats(queue)
  end

  test "take releases a recovery frame on transport handoff" do
    queue = OutboundQueue.new()
    assert :ok = OutboundQueue.push(queue, "page", replay_page?: true)
    assert {:ok, %{queued_events: 1, queued_replay_pages: 1}} = OutboundQueue.stats(queue)
    assert {:ok, %{encoded: "page", replay_page?: true}} = OutboundQueue.take(queue)

    assert {:ok, %{queued_events: 0, queued_bytes: 0, queued_replay_pages: 0}} =
             OutboundQueue.stats(queue)
  end

  test "recovery ACK accepts revision zero and releases only its exact frame" do
    queue = OutboundQueue.new()
    assert :ok = OutboundQueue.push(queue, "snapshot", revision: 0, state_digest: "digest-0")
    assert :ok = OutboundQueue.push(queue, "live", revision: 1, state_digest: "digest-1")
    assert {:ok, %{revision: 0}} = OutboundQueue.pop(queue)
    assert {:ok, %{revision: 1}} = OutboundQueue.pop(queue)

    assert {:error, :digest_mismatch} = OutboundQueue.ack_recovery(queue, 0, "wrong")

    assert {:ok, %{queued_events: 1, in_flight_events: 1}} =
             OutboundQueue.ack_recovery(queue, 0, "digest-0")

    assert {:ok, %{queued_events: 0}} = OutboundQueue.ack(queue, 1, "digest-1")
  end

  test "retains transport in-flight reservations until a matching cumulative ACK" do
    queue = queue_at(0)

    for revision <- 1..256 do
      assert :ok =
               OutboundQueue.push(queue, "x",
                 revision: revision,
                 state_digest: "digest-#{revision}"
               )

      assert {:ok, %{revision: ^revision}} = OutboundQueue.pop(queue)
    end

    assert :empty = OutboundQueue.pop(queue)
    assert {:error, {:overflow, :event_limit}} = OutboundQueue.push(queue, "overflow")
  end

  test "rejects unsent, unknown, and digest-mismatched delivery ACKs" do
    queue = queue_at(0)
    assert :ok = OutboundQueue.push(queue, "one", revision: 1, state_digest: "digest-1")
    assert {:error, :unknown_ack} = OutboundQueue.ack(queue, 1, "digest-1")
    assert {:ok, %{revision: 1}} = OutboundQueue.pop(queue)
    assert {:error, :digest_mismatch} = OutboundQueue.ack(queue, 1, "wrong")
    assert {:error, :unknown_ack} = OutboundQueue.ack(queue, 2, "digest-2")
    assert {:ok, %{queued_events: 0}} = OutboundQueue.ack(queue, 1, "digest-1")
  end

  test "accepts exactly 256 control events and closes only the overflowing queue" do
    queue = queue_at(0)
    unaffected = queue_at(0)

    for _ <- 1..256, do: assert(:ok = OutboundQueue.push(queue, "x"))

    assert {:error, {:overflow, :event_limit}} = OutboundQueue.push(queue, "x")
    assert {:error, :closed} = OutboundQueue.peek(queue)

    assert :ok = OutboundQueue.push(unaffected, "still available")
    assert {:ok, %{encoded: "still available"}} = OutboundQueue.pop(unaffected)
  end

  test "accepts exactly one mebibyte of encoded bytes" do
    queue = queue_at(0)
    mebibyte = :binary.copy("x", 1_048_576)

    assert :ok = OutboundQueue.push(queue, mebibyte)
    assert {:ok, %{queued_bytes: 1_048_576}} = OutboundQueue.stats(queue)
    assert {:error, {:overflow, :byte_limit}} = OutboundQueue.push(queue, "x")
    assert {:error, :closed} = OutboundQueue.stats(queue)
  end

  test "closes at five queued replay pages" do
    queue = queue_at(0)

    for _ <- 1..5, do: assert(:ok = OutboundQueue.push(queue, "page", replay_page?: true))

    assert {:ok, %{queued_events: 5, queued_replay_pages: 5}} = OutboundQueue.stats(queue)

    assert {:error, {:overflow, :replay_page_limit}} =
             OutboundQueue.push(queue, "page", replay_page?: true)
  end

  test "closes when the oldest queued frame reaches five seconds" do
    {queue, clock} = queue_with_clock(0)

    assert :ok = OutboundQueue.push(queue, "first")
    advance(clock, 4_999)
    assert {:ok, %{oldest_age_ms: 4_999}} = OutboundQueue.stats(queue)

    advance(clock, 1)
    assert {:error, {:overflow, :age_limit}} = OutboundQueue.peek(queue)
    assert {:error, :closed} = OutboundQueue.pop(queue)
  end

  test "close removes ETS payload tables and rejects later operations" do
    queue = queue_at(0)

    assert :ok = OutboundQueue.push(queue, "payload", revision: 7)
    assert {:ok, %{queued_events: 1, queued_bytes: 7}} = OutboundQueue.close(queue)
    assert :undefined = :ets.info(queue.entries)
    assert :undefined = :ets.info(queue.state)
    assert {:error, :closed} = OutboundQueue.push(queue, "later")
    assert {:error, :closed} = OutboundQueue.stats(queue)
  end

  test "owner termination cleans up ETS tables" do
    parent = self()

    owner =
      spawn(fn ->
        queue = OutboundQueue.new()
        send(parent, {:queue, queue})

        receive do
          :stop -> :ok
        end
      end)

    assert_receive {:queue, queue}
    monitor = Process.monitor(owner)
    send(owner, :stop)
    assert_receive {:DOWN, ^monitor, :process, ^owner, :normal}
    assert :undefined = :ets.info(queue.entries)
    assert :undefined = :ets.info(queue.state)
  end

  test "rejects concurrent off-owner mutation without queueing payloads" do
    queue = queue_at(0)

    results =
      Task.async_stream(
        1..16,
        fn _ -> OutboundQueue.push(queue, "payload") end,
        max_concurrency: 16,
        ordered: false
      )
      |> Enum.to_list()

    assert Enum.all?(results, &(&1 == {:ok, {:error, :not_owner}}))
    assert {:ok, %{queued_events: 0, queued_bytes: 0}} = OutboundQueue.stats(queue)
  end

  test "does not put encoded payloads into the owner mailbox" do
    parent = self()

    spawn(fn ->
      queue = queue_at(0)
      {:message_queue_len, before} = Process.info(self(), :message_queue_len)

      for _ <- 1..16, do: assert(:ok = OutboundQueue.push(queue, "payload"))

      {:message_queue_len, after_pushes} = Process.info(self(), :message_queue_len)
      send(parent, {:mailbox_lengths, before, after_pushes})
    end)

    assert_receive {:mailbox_lengths, before, after_pushes}
    assert before == after_pushes
  end

  defp queue_at(now) do
    {queue, _clock} = queue_with_clock(now)
    queue
  end

  defp queue_with_clock(now) do
    clock = :atomics.new(1, [])
    :atomics.put(clock, 1, now)
    {OutboundQueue.new(clock: fn -> :atomics.get(clock, 1) end), clock}
  end

  defp advance(clock, milliseconds), do: :atomics.add_get(clock, 1, milliseconds)
end
