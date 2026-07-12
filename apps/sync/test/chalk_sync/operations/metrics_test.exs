defmodule ChalkSync.Operations.MetricsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Operations.Metrics
  alias ChalkSync.Telemetry

  test "aggregates telemetry in ETS without payload or identifier dimensions" do
    metric = "chalk.sync.command.admission.other"
    before = get_in(Metrics.snapshot(), [:metrics, metric, :count]) || 0

    Telemetry.execute(
      [:command, :admission],
      %{duration_us: 17, bytes: 23},
      %{outcome: :deliberately_unknown, token: "must-not-be-retained"}
    )

    snapshot = Metrics.snapshot()
    assert get_in(snapshot, [:metrics, metric, :count]) >= before + 1
    assert get_in(snapshot, [:metrics, metric, :total_duration_us]) >= 17
    assert get_in(snapshot, [:metrics, metric, :total_bytes]) >= 23
    refute inspect(snapshot) =~ "must-not-be-retained"
  end
end
