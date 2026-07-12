defmodule ChalkSync.UUIDTest do
  use ExUnit.Case, async: true

  alias ChalkSync.UUID

  test "generated UUIDs round trip through Postgrex bytes" do
    uuid = UUID.generate()
    assert {:ok, bytes} = UUID.dump(uuid)
    assert {:ok, ^uuid} = UUID.load(bytes)
    assert String.match?(uuid, ~r/^[0-9a-f-]{36}$/)
  end

  test "rejects noncanonical or unsupported UUIDs" do
    assert UUID.dump("not-a-uuid") == :error
    assert UUID.dump("00000000-0000-0000-0000-000000000000") == :error
  end
end
