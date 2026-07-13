defmodule ChalkSync.SyncBreakerV3.DeliveryGateAdapterTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV3.DeliveryGateAdapter

  test "executes decisions and bounded held, released, dropped, and duplicate emissions" do
    recipient = self()

    {:ok, _gate} = DeliveryGateAdapter.start_link([{:postgres_head_hint, :drop}])
    on_exit(&DeliveryGateAdapter.stop/0)

    assert :drop == DeliveryGateAdapter.decide(:postgres_head_hint, %{revision: 2})
    assert {:ok, %{action: :drop}} = DeliveryGateAdapter.await(1)
    DeliveryGateAdapter.stop()

    {:ok, _gate} =
      DeliveryGateAdapter.start_link([
        {:control_ready, {:hold, :control}},
        {:command_result, :drop},
        {:live_frame, :duplicate}
      ])

    assert :ok = DeliveryGateAdapter.emit(:control_ready, %{}, recipient, :control)
    assert :ok = DeliveryGateAdapter.emit(:command_result, %{}, recipient, :ack)
    assert :ok = DeliveryGateAdapter.emit(:live_frame, %{}, recipient, :live)
    assert DeliveryGateAdapter.held_count() == 1
    refute_received :control
    refute_received :ack
    assert_received :live
    assert_received :live
    assert {:ok, 1} = DeliveryGateAdapter.release(:control)
    assert_received :control
    assert length(DeliveryGateAdapter.observations()) == 3
  end
end
