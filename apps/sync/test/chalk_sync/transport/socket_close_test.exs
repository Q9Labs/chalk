defmodule ChalkSync.Transport.SocketCloseTest do
  use ExUnit.Case, async: false
  alias ChalkSync.Transport.SocketClose
  alias ChalkSync.Transport.SocketV1
  alias ChalkSync.Transport.SocketWhiteboardV1

  setup do
    handler = "alert-closures-#{System.unique_integer([:positive])}"
    owner = self()

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event == "sync.websocket.closed",
          do: send(owner, {:closed, metadata.attributes})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
  end

  test "thirteen people leaving both sockets do not count as failures" do
    for _participant <- 1..13, socket <- [SocketV1, SocketWhiteboardV1] do
      assert {:ok, state} = socket.init(%{})
      assert :ok = socket.terminate(:remote, state)
      assert_received {:closed, %{reason: :client_closed, close_kind: :normal}}
    end

    refute_received {:closed, %{close_kind: :abnormal}}
  end

  test "twelve abrupt drops cross the ten-failure threshold, while drains do not" do
    for socket <- [SocketV1, SocketWhiteboardV1], _connection <- 1..6 do
      assert {:ok, state} = socket.init(%{})
      assert :ok = socket.terminate({:error, :closed}, state)
      assert_received {:closed, %{reason: :transport_error, close_kind: :abnormal}}
    end

    for socket <- [SocketV1, SocketWhiteboardV1] do
      assert {:ok, state} = socket.init(%{})
      assert :ok = socket.terminate(:shutdown, state)
      assert_received {:closed, %{reason: :server_shutdown, close_kind: :drain}}
    end
  end

  test "heartbeat timeout remains abnormal when WebSock calls terminate normally" do
    assert {:ok, initial} = SocketV1.init(%{})
    now = System.monotonic_time(:millisecond)

    state = %{
      initial
      | phase: :live,
        missed_heartbeats: 4,
        opened_at_ms: now - 90_000,
        last_heartbeat_at_ms: now - 70_000
    }

    assert {:stop, :normal, {1001, "heartbeat timeout"}, stopped} =
             SocketV1.handle_info(:heartbeat_check, state)

    assert :ok = SocketV1.terminate(:normal, stopped)

    assert_received {:closed,
                     %{reason: :timeout, close_code: 1001, close_kind: :abnormal} = attributes}

    assert attributes.socket_age_ms >= 90_000
    assert attributes.heartbeat_gap_ms >= 70_000
  end

  test "acknowledging a class end is normal" do
    assert SocketClose.attributes(:normal, %{
             reason: :normal,
             close_code: 1000
           }) ==
             %{reason: :normal, close_code: 1000, close_kind: :normal}
  end
end
