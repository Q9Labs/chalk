defmodule ChalkSync.ProtocolTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Protocol

  describe "decode/1" do
    test "hello with and without a cursor" do
      assert {:ok, {:hello, %{token: "t", cursor: nil}}} =
               Protocol.decode(~s({"type":"hello","protocol":1,"token":"t"}))

      assert {:ok, {:hello, %{token: "t", cursor: 41}}} =
               Protocol.decode(
                 ~s({"type":"hello","protocol":1,"token":"t","streams":{"control":{"cursor":41}}})
               )
    end

    test "hello with a wrong protocol version or bad cursor is rejected" do
      assert {:error, :unsupported_protocol} =
               Protocol.decode(~s({"type":"hello","protocol":2,"token":"t"}))

      assert {:error, :invalid_cursor} =
               Protocol.decode(
                 ~s({"type":"hello","protocol":1,"token":"t","streams":{"control":{"cursor":-1}}})
               )

      assert {:error, :invalid_cursor} =
               Protocol.decode(~s({"type":"hello","protocol":1,"token":"t","streams":"bad"}))
    end

    test "commands map to the whitelist only" do
      assert {:ok, {:command, %{command_id: "c-1", name: :raise_hand, payload: %{}}}} =
               Protocol.decode(~s({"type":"command","command_id":"c-1","name":"raise_hand"}))

      assert {:error, :unknown_command} =
               Protocol.decode(~s({"type":"command","command_id":"c-1","name":"join"}))
    end

    test "malformed frames fail closed" do
      assert {:error, :malformed_json} = Protocol.decode("{nope")
      assert {:error, :missing_type} = Protocol.decode(~s({"a":1}))
      assert {:error, :unknown_type} = Protocol.decode(~s({"type":"mystery"}))
      assert {:error, :invalid_command} = Protocol.decode(~s({"type":"command","name":"x"}))
    end

    test "ping decodes with normalized correlation fields" do
      assert {:ok, {:ping, %{}}} = Protocol.decode(~s({"type":"ping"}))

      assert {:ok, {:ping, %{journey_id: "00000000-0000-4000-8000-000000000001"}}} =
               Protocol.decode(
                 ~s({"type":"ping","journey_id":"00000000-0000-4000-8000-000000000001"})
               )
    end
  end

  describe "encode" do
    test "acks carry command outcome" do
      assert JSON.decode!(Protocol.encode_ack("c-1", {:committed, 42})) ==
               %{
                 "type" => "ack",
                 "command_id" => "c-1",
                 "result" => "committed",
                 "revision" => 42
               }

      assert JSON.decode!(Protocol.encode_ack("c-1", {:duplicate, 42})) ==
               %{
                 "type" => "ack",
                 "command_id" => "c-1",
                 "result" => "duplicate",
                 "revision" => 42
               }

      assert JSON.decode!(Protocol.encode_ack("c-1", {:rejected, :no_change})) ==
               %{
                 "type" => "ack",
                 "command_id" => "c-1",
                 "result" => "rejected",
                 "reason" => "no_change"
               }
    end

    test "events carry the exact revision chain" do
      event = %{name: "hand_raised", base_revision: 41, revision: 42, payload: %{"a" => 1}}

      assert JSON.decode!(Protocol.encode_event(event)) == %{
               "type" => "event",
               "stream" => "control",
               "name" => "hand_raised",
               "base_revision" => 41,
               "revision" => 42,
               "payload" => %{"a" => 1}
             }
    end

    test "welcome encodes snapshot and replay modes" do
      snapshot =
        JSON.decode!(Protocol.encode_welcome("p1", %{snapshot: %{"control_revision" => 1}}))

      assert %{"type" => "welcome", "mode" => "snapshot", "participant_id" => "p1"} = snapshot

      event = %{name: "hand_raised", base_revision: 1, revision: 2, payload: %{}}

      replay =
        JSON.decode!(Protocol.encode_welcome("p1", %{replay: [event], control_revision: 2}))

      assert %{"mode" => "replay", "control_revision" => 2, "events" => [%{"revision" => 2}]} =
               replay
    end
  end
end
