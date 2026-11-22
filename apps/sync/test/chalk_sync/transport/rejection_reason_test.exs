defmodule ChalkSync.Transport.RejectionReasonTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.OperationDecision

  @command_id "cmd-start-recording-1"

  test "a start_recording the call's policy refuses answers as a denied capability instead of crashing the socket" do
    frame =
      ProtocolV1.operation_decision(%OperationDecision{
        request_key: @command_id,
        result: :rejected,
        reason: :recording_policy_disabled
      })

    assert JSON.decode!(frame) == %{
             "type" => "ack",
             "command_id" => @command_id,
             "delivery" => "original",
             "outcome" => "rejected",
             "reason" => "capability_denied"
           }
  end

  test "a command the policy refuses gets the same reason" do
    frame =
      ProtocolV1.ack(%Decision{
        command_id: @command_id,
        result: :rejected,
        reason: :recording_policy_disabled
      })

    assert %{"outcome" => "rejected", "reason" => "capability_denied"} = JSON.decode!(frame)
  end

  test "reasons protocol v1 carries pass through unchanged" do
    frame =
      ProtocolV1.operation_decision(%OperationDecision{
        request_key: @command_id,
        result: :rejected,
        reason: :recording_in_progress
      })

    assert %{"reason" => "recording_in_progress"} = JSON.decode!(frame)
  end
end
