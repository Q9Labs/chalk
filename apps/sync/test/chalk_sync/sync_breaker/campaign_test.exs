defmodule ChalkSync.SyncBreaker.CampaignTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreaker.Campaign

  @tag :tmp_dir
  test "runs selected cases and writes replayable artifacts", %{tmp_dir: tmp_dir} do
    result =
      Campaign.run(
        seed: 400,
        cases: 2,
        steps: 20,
        participants: 2,
        output: tmp_dir,
        scenarios: ["model"]
      )

    assert result.verdict == :pass
    assert File.exists?(result.report)
    assert length(result.results) == 2
    assert Enum.all?(result.results, &(&1.status == :pass))
    assert Enum.all?(result.results, &File.exists?(&1.evidence["result_trace"]))
    assert Path.wildcard(Path.join(result.run_directory, "model-*.jsonl")) != []

    result.results
    |> hd()
    |> Map.fetch!(:evidence)
    |> Map.fetch!("result_trace")
    |> File.stream!()
    |> Enum.at(0)
    |> JSON.decode!()
    |> then(&assert &1["kind"] == "manifest")
  end

  @tag :tmp_dir
  test "isolates real-wire socket ownership from the campaign process", %{tmp_dir: tmp_dir} do
    result =
      Campaign.run(
        seed: 500,
        cases: 3,
        steps: 10,
        participants: 2,
        retries: false,
        writer_restarts: false,
        output: tmp_dir,
        scenarios: ["random_wire"]
      )

    assert result.verdict == :pass
    {:messages, messages} = Process.info(self(), :messages)
    refute Enum.any?(messages, &tcp_message?/1)
  end

  defp tcp_message?({:tcp, _socket, _data}), do: true
  defp tcp_message?({:tcp_closed, _socket}), do: true
  defp tcp_message?({:tcp_error, _socket, _reason}), do: true
  defp tcp_message?(_message), do: false
end
