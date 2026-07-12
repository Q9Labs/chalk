defmodule ChalkSync.CanonicalJSONTest do
  use ExUnit.Case, async: true

  alias ChalkSync.CanonicalJSON

  test "sorts object keys and preserves array order" do
    assert CanonicalJSON.encode!(%{"z" => 1, "a" => [true, nil, "é"]}) ==
             ~s({"a":[true,null,"é"],"z":1})
  end

  test "rejects values outside the durable projection grammar" do
    assert_raise ArgumentError, fn -> CanonicalJSON.encode!(%{"float" => 1.5}) end
  end
end
