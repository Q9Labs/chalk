defmodule ChalkSync.SyncBreaker.ShrinkerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreaker.Shrinker

  test "removes irrelevant operations while preserving the failure" do
    operations = [1, 2, 3, 4, 5, 6]
    reproduces_failure? = fn candidate -> 3 in candidate and 5 in candidate end

    assert Shrinker.shrink(operations, reproduces_failure?) == [3, 5]
  end

  test "requires a reproducing starting scenario" do
    assert_raise ArgumentError, ~r/does not reproduce/, fn ->
      Shrinker.shrink([1, 2], fn _candidate -> false end)
    end
  end
end
