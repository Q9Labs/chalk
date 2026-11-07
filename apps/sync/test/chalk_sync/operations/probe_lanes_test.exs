defmodule ChalkSync.Operations.ProbeLanesTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Operations.Probe

  @poll_interval_ms 10

  for {failing, healthy} <- [local: :provider, provider: :local] do
    @failing failing
    @healthy healthy

    test "a failing #{@failing} lane is named in the readiness event" do
      start_lane(@healthy, fn _limit -> {:ok, []} end)
      start_lane(@failing, fn _limit -> {:retryable, :database_unavailable} end)
      await_lane_state(@healthy, &(&1.last_success_at_ms != nil))
      await_lane_state(@failing, &(&1.consecutive_failures >= 2))

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          assert {:error, :external_operation_consumer_unavailable} =
                   Probe.observe_external_operation_lanes(false)
        end)

      assert log =~ "\"event\":\"sync.readiness.failed\""
      assert log =~ "\"check\":\"external_operation_consumer_#{@failing}\""
      refute log =~ "\"check\":\"external_operation_consumer_#{@healthy}\""
    end
  end

  defp start_lane(lane, claim_operations) do
    name = Keyword.fetch!(ExternalOperationConsumer.lane_names(), lane)

    start_supervised!(
      Supervisor.child_spec(
        {ExternalOperationConsumer,
         lane: lane,
         name: name,
         poll_interval_ms: @poll_interval_ms,
         max_backoff_ms: @poll_interval_ms,
         claim_operations: claim_operations},
        id: name
      )
    )
  end

  defp await_lane_state(lane, ready?, attempts \\ 200) do
    health =
      ExternalOperationConsumer.health(
        Keyword.fetch!(ExternalOperationConsumer.lane_names(), lane)
      )

    cond do
      ready?.(health) ->
        :ok

      attempts == 0 ->
        flunk("#{lane} lane did not reach the expected state: #{inspect(health)}")

      true ->
        Process.sleep(@poll_interval_ms)
        await_lane_state(lane, ready?, attempts - 1)
    end
  end
end
