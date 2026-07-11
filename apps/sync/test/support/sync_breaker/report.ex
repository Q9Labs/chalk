defmodule ChalkSync.SyncBreaker.Report do
  @moduledoc false

  alias ChalkSync.SyncBreaker.Result

  def create_run_directory(root, seed) do
    timestamp = DateTime.utc_now() |> DateTime.to_iso8601(:basic) |> String.replace("Z", "")
    path = Path.join(root, "#{timestamp}-seed-#{seed}-#{System.unique_integer([:positive])}")
    File.mkdir_p!(path)
    path
  end

  def write(run_directory, metadata, results) do
    summary = summary(metadata, results)
    File.write!(Path.join(run_directory, "summary.json"), JSON.encode!(summary))
    File.write!(Path.join(run_directory, "report.md"), markdown(summary))
    :ok
  end

  def summary(metadata, results) do
    counts = Enum.frequencies_by(results, & &1.status)

    %{
      "verdict" => verdict(results),
      "generated_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "metadata" => metadata,
      "counts" => %{
        "pass" => Map.get(counts, :pass, 0),
        "fail" => Map.get(counts, :fail, 0),
        "error" => Map.get(counts, :error, 0)
      },
      "results" => Enum.map(results, &Result.to_map/1)
    }
  end

  defp verdict(results) do
    if Enum.all?(results, &(&1.status == :pass)), do: "PASS", else: "FAIL"
  end

  defp markdown(summary) do
    failures = Enum.reject(summary["results"], &(&1["status"] == "pass"))
    passes = Enum.filter(summary["results"], &(&1["status"] == "pass"))

    [
      "# Chalk Sync Breaker Report\n",
      "Verdict: **#{summary["verdict"]}**\n",
      "Generated: #{summary["generated_at"]}\n",
      counts_table(summary["counts"]),
      "## Failures\n",
      result_sections(failures, "No invariant failures were observed."),
      "## Passing scenarios\n",
      result_sections(passes, "No scenarios passed.")
    ]
  end

  defp counts_table(counts) do
    """
    | Passed | Failed | Harness errors |
    | ---: | ---: | ---: |
    | #{counts["pass"]} | #{counts["fail"]} | #{counts["error"]} |

    """
  end

  defp result_sections([], empty_message), do: "#{empty_message}\n\n"

  defp result_sections(results, _empty_message) do
    Enum.map(results, fn result ->
      evidence = JSON.encode!(result["evidence"] || %{})

      """
      ### `#{result["scenario"]}` — #{String.upcase(result["status"])}

      - Seed: #{result["seed"] || "n/a"}
      - Invariant: #{result["invariant"] || "n/a"}
      - Message: #{result["message"] || "n/a"}
      - Evidence: `#{escape_backticks(evidence)}`

      """
    end)
  end

  defp escape_backticks(value), do: String.replace(value, "`", "\\`")
end
