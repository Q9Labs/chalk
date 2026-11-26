defmodule ChalkSync.Transport.PresentingRejectionTelemetryTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Transport.Socket.Presenting

  @reasons ~w(capacity forbidden invalid_state invalid_target not_active operation_id_conflict rate_limited)

  setup do
    handler = "presenting-rejection-#{System.unique_integer([:positive])}"
    test_pid = self()

    :telemetry.attach(
      handler,
      [:chalk, :sync, :presenting, :rejection],
      fn _event, measurements, metadata, _config -> send(test_pid, {:rejection, measurements, metadata}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
  end

  test "each rejection reason emits exactly one event tagged with that reason" do
    for reason <- @reasons do
      Presenting.observe_receipt(%{"kind" => "rejected", "reason" => reason})

      assert_received {:rejection, %{count: 1}, %{reason: ^reason} = metadata}
      assert Map.keys(metadata) == [:reason]
      refute_received {:rejection, _measurements, _metadata}
    end
  end

  test "an accepted receipt emits no rejection event" do
    Presenting.observe_receipt(%{"kind" => "accepted"})

    refute_received {:rejection, _measurements, _metadata}
  end
end
