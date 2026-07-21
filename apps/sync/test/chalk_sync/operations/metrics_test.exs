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

  test "webhook counters retain only bounded event and API-version labels" do
    production_metric = "chalk.sync.webhook.production.committed.participant_left.v1"
    fanout_metric = "chalk.sync.webhook.fanout.queued.participant_left.v1"
    before = Metrics.snapshot().metrics

    Telemetry.execute(
      [:webhook, :production],
      %{count: 1},
      %{
        api_version: 1,
        event_name: "participant.left",
        outcome: :committed,
        tenant_id: "must-not-be-retained"
      }
    )

    Telemetry.execute(
      [:webhook, :fanout],
      %{count: 3},
      %{api_version: 1, event_name: "participant.left", outcome: :queued}
    )

    snapshot = Metrics.snapshot().metrics

    assert snapshot[production_metric].count ==
             (get_in(before, [production_metric, :count]) || 0) + 1

    assert snapshot[fanout_metric].count == (get_in(before, [fanout_metric, :count]) || 0) + 3
    refute inspect(snapshot) =~ "must-not-be-retained"
  end

  test "provider execution metrics retain only bounded operation and outcome labels" do
    metric = "chalk.sync.external_operation.execution.pending.participant_leave"
    before = get_in(Metrics.snapshot(), [:metrics, metric, :count]) || 0

    Telemetry.execute(
      [:external_operation, :execution],
      %{count: 1, duration_us: 23},
      %{
        operation: :participant_leave,
        outcome: :pending,
        external_operation_id: "must-not-be-retained"
      }
    )

    snapshot = Metrics.snapshot()
    assert get_in(snapshot, [:metrics, metric, :count]) == before + 1
    assert get_in(snapshot, [:metrics, metric, :total_duration_us]) >= 23
    refute inspect(snapshot) =~ "must-not-be-retained"
  end
end
