defmodule ChalkSync.SyncBreakerV1.VerdictTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreakerV1.Verdict

  test "fails closed when an invariant or dependency does not pass" do
    assert Verdict.from_invariants(%{"receipt_stable" => true}) == "pass"
    assert Verdict.from_invariants(%{"receipt_stable" => false}) == "fail"
    assert Verdict.from_invariants(%{"receipt_stable" => "true"}) == "fail"
    assert Verdict.from_invariants(%{}) == "fail"

    assert Verdict.from_invariants(
             %{"receipt_stable" => true},
             [%{"verdict" => "fail"}]
           ) == "fail"

    refute Verdict.pass?(%{"verdict" => "fail"})
    refute Verdict.pass?(%{})
  end
end
