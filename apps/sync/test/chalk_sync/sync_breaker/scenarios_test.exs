defmodule ChalkSync.SyncBreaker.ScenariosTest do
  use ChalkSync.ServerCase, async: true

  alias ChalkSync.SyncBreaker.Result
  alias ChalkSync.SyncBreaker.Scenarios

  test "writer restart retry reports rejected no_change instead of duplicate", %{port: port} do
    result = Scenarios.idempotency_retry_after_writer_restart(port)

    assert %Result{status: :fail, invariant: :idempotency} = result
    assert %{"result" => "committed", "revision" => revision} = result.evidence["original_ack"]
    assert %{"result" => "rejected", "reason" => "no_change"} = result.evidence["retry_ack"]
    assert result.evidence["restart"]["close_code"] == 1012
    assert is_integer(revision)
    assert [_ | _] = hand_states = trace_values(result.trace, "hand_raised")
    assert Enum.all?(hand_states, &is_boolean/1)
    assert result.trace != []
  end

  test "abrupt TCP loss reconnects through a convergent replay", %{port: port} do
    result = Scenarios.reconnect_replay_convergence(port)

    assert %Result{status: :pass, invariant: :replay_convergence} = result
    assert %{"mode" => "replay"} = result.evidence["replay_welcome"]
    assert result.evidence["model_snapshot"] == result.evidence["authoritative_snapshot"]
    assert result.trace != []
  end

  test "pure room replay jump probe reports the accepted revision gap" do
    result = Scenarios.replay_revision_jump_probe()

    assert %Result{status: :fail, invariant: :revision_continuity} = result
    assert result.evidence["event"]["base_revision"] == 0
    assert result.evidence["event"]["revision"] == 5
    assert result.evidence["result"]["room"]["control_revision"] == 5
    assert result.trace != []
  end

  test "revision jump probe passes only for an explicit revision-gap rejection" do
    reject = fn _room, _event -> {:error, :revision_gap} end
    ambiguous = fn room, _event -> %{room | revision: 1} end

    assert %Result{status: :pass} = Scenarios.replay_revision_jump_probe(reject)
    assert %Result{status: :fail} = Scenarios.replay_revision_jump_probe(ambiguous)
  end

  defp trace_values(map, key) when is_map(map) do
    own =
      case Map.fetch(map, key),
        do: (
          {:ok, value} -> [value]
          :error -> []
        )

    own ++ Enum.flat_map(Map.values(map), &trace_values(&1, key))
  end

  defp trace_values(list, key) when is_list(list), do: Enum.flat_map(list, &trace_values(&1, key))
  defp trace_values(_value, _key), do: []
end
