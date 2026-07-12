defmodule ChalkSync.SyncBreakerV2.Replay do
  @moduledoc false

  alias ChalkSync.SyncBreakerV2.Replica
  alias ChalkSync.SyncBreakerV2.TraceArtifact

  def verify(path) do
    trace_path = if File.dir?(path), do: Path.join(path, "trace.jsonl"), else: path

    with {:ok, records} <- TraceArtifact.read_trace(trace_path),
         {:ok, replicas} <- replay_sessions(records),
         :ok <- verify_heads(records, replicas) do
      {:ok, %{sessions: map_size(replicas), trace: trace_path}}
    end
  end

  defp replay_sessions(records) do
    Enum.reduce_while(records, {:ok, %{}}, fn
      %{"record" => %{"kind" => "event", "session_id" => session_id, "frame" => frame}},
      {:ok, replicas} ->
        case Replica.apply_event(Map.get(replicas, session_id, Replica.new()), frame) do
          {:ok, replica} -> {:cont, {:ok, Map.put(replicas, session_id, replica)}}
          {:error, reason} -> {:halt, {:error, {:event, session_id, reason}}}
        end

      _record, accumulator ->
        {:cont, accumulator}
    end)
  end

  defp verify_heads(records, replicas) do
    records
    |> Enum.filter(&match?(%{"record" => %{"kind" => "final_head"}}, &1))
    |> verify_final_heads(replicas)
  end

  defp verify_final_heads([], _replicas), do: {:error, :missing_final_head}

  defp verify_final_heads(heads, replicas) do
    Enum.reduce_while(heads, :ok, &verify_final_head(&1, &2, replicas))
  end

  defp verify_final_head(%{"record" => head}, :ok, replicas) do
    replica = Map.get(replicas, head["session_id"])

    if replica && replica.revision == head["revision"] &&
         Replica.digest_hex(replica) == head["state_digest"] do
      {:cont, :ok}
    else
      {:halt, {:error, {:head, head["session_id"], :mismatch}}}
    end
  end
end
