defmodule ChalkSync.Operations.ReadinessTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Operations.Readiness

  for {fault, observed} <- [exception: "exception", killed: "terminated"] do
    @fault fault
    @observed observed

    test "logs a #{@fault} probe worker without private failure text" do
      probe = fn ->
        case @fault do
          :exception -> raise "private failure text must not escape"
          :killed -> Process.exit(self(), :kill)
        end
      end

      readiness =
        start_supervised!({Readiness, name: nil, auto_probe?: false, probe_fun: probe})

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          health = Readiness.probe_now(readiness)
          assert health.status == "unready"
          assert health.dependencies == %{reason: "probe_failed"}
        end)

      assert log =~ "\"event\":\"sync.readiness.failed\""
      assert log =~ "\"check\":\"probe_worker\""
      assert log =~ "\"observed\":\"#{@observed}\""
      refute log =~ "private failure text"
    end
  end
end
