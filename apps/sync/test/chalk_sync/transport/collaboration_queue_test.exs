defmodule ChalkSync.Transport.CollaborationQueueTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Transport.CollaborationQueue, as: OutboundQueue

  test "preserves FIFO and yields to pending control after eight space actions" do
    queue = OutboundQueue.new()

    for index <- 1..9 do
      assert :ok = OutboundQueue.push(queue, Integer.to_string(index))
    end

    for index <- 1..8 do
      assert {:ok, %{encoded: encoded, kind: :frame}} =
               OutboundQueue.take(queue, true)

      assert encoded == Integer.to_string(index)
    end

    assert :control_required = OutboundQueue.take(queue, true)
    assert :ok = OutboundQueue.control_checked(queue)
    assert {:ok, %{encoded: "9"}} = OutboundQueue.take(queue, true)
    assert :empty = OutboundQueue.take(queue, true)
  end

  test "bounds frame count, individual payloads, and total bytes without closing" do
    queue = OutboundQueue.new()

    for _index <- 1..256 do
      assert :ok = OutboundQueue.push(queue, "x")
    end

    assert {:error, {:overflow, :frame_count}} = OutboundQueue.push(queue, "overflow")
    assert {:ok, %{queued_frames: 256, queued_bytes: 256}} = OutboundQueue.stats(queue)

    another = OutboundQueue.new()

    assert {:error, {:overflow, :frame_bytes}} =
             OutboundQueue.push(another, :binary.copy("x", 32_769))

    assert :ok =
             OutboundQueue.push(another, :binary.copy("x", 131_072), kind: :chat_page)

    assert {:error, {:overflow, :page_bytes}} =
             OutboundQueue.push(another, :binary.copy("x", 131_073), kind: :chat_page)
  end

  test "rejects off-owner access and deletes private tables on close" do
    queue = OutboundQueue.new()
    task = Task.async(fn -> OutboundQueue.push(queue, "payload") end)

    assert {:error, :not_owner} = Task.await(task)
    assert :ok = OutboundQueue.close(queue)
    assert {:error, :closed} = OutboundQueue.stats(queue)
  end
end
