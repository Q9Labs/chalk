defmodule ChalkSync.ProtocolV3Test do
  use ExUnit.Case, async: true

  alias ChalkSync.ProtocolV3

  test "decodes the control stream on a strict delivery acknowledgement" do
    digest = String.duplicate("a", 64)

    assert {:ok, {:delivery_ack, %{stream: :control, revision: 2, state_digest: ^digest}}} =
             ProtocolV3.decode(
               JSON.encode!(%{
                 "type" => "delivery_ack",
                 "stream" => "control",
                 "revision" => 2,
                 "state_digest" => digest
               })
             )
  end
end
