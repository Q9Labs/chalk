defmodule ChalkSync.SyncBreaker.ReportTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreaker.Report
  alias ChalkSync.SyncBreaker.Result

  @tag :tmp_dir
  test "writes a machine summary and failure-first Markdown report", %{tmp_dir: tmp_dir} do
    run_directory = Report.create_run_directory(tmp_dir, 42)

    results = [
      Result.pass("convergence", seed: 42),
      Result.fail("replay", :revision_gap, "expected revision 4", seed: 42)
    ]

    assert :ok = Report.write(run_directory, %{"seed" => 42}, results)

    summary = run_directory |> Path.join("summary.json") |> File.read!() |> JSON.decode!()
    markdown = File.read!(Path.join(run_directory, "report.md"))

    assert summary["verdict"] == "FAIL"
    assert summary["counts"] == %{"pass" => 1, "fail" => 1, "error" => 0}
    assert markdown =~ "# Chalk Sync Breaker Report"
    assert markdown =~ "### `replay` — FAIL"
    assert markdown =~ "revision_gap"
  end

  @tag :tmp_dir
  test "normalizes tuple failure details for portable JSON", %{tmp_dir: tmp_dir} do
    run_directory = Report.create_run_directory(tmp_dir, 43)

    result =
      Result.fail("retry", :idempotency, {:changed, %{revision: 1}, %{revision: 2}},
        evidence: %{reason: {:changed, 1, 2}, converged: true, snapshot: nil}
      )

    assert :ok = Report.write(run_directory, %{}, [result])

    assert %{"results" => [%{"message" => message, "evidence" => evidence}]} =
             run_directory |> Path.join("summary.json") |> File.read!() |> JSON.decode!()

    assert message =~ "{:changed"

    assert evidence == %{
             "reason" => ["changed", 1, 2],
             "converged" => true,
             "snapshot" => nil
           }
  end
end
