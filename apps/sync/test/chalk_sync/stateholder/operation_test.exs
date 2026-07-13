defmodule ChalkSync.Stateholder.OperationTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Stateholder.Operation

  @uuid "55555555-5555-4555-8555-555555555555"

  test "validates and fingerprints every websocket external operation" do
    operations = [
      {:admit_participant, %{"admissionRequestId" => @uuid}},
      {:deny_admission, %{"admissionRequestId" => @uuid}},
      {:admission_request_expired, %{"admissionRequestId" => @uuid}},
      {:mute_participant, %{"participantSessionId" => @uuid}},
      {:stop_participant_camera, %{"participantSessionId" => @uuid}},
      {:stop_participant_screen_share, %{"participantSessionId" => @uuid}},
      {:remove_participant, %{"participantSessionId" => @uuid}},
      {:start_recording, %{"recordingId" => @uuid}},
      {:stop_recording, %{"recordingId" => @uuid}},
      {:participant_leave, %{}},
      {:end_session, %{}},
      {:tenant_transfer_host, %{"participantSessionId" => @uuid}},
      {:tenant_set_deadline, %{"deadlineAtMs" => 10_000, "deadlineGeneration" => 2}},
      {:tenant_end_session, %{}},
      {:maximum_duration_expired, %{"deadlineGeneration" => 2}}
    ]

    Enum.each(operations, fn {name, payload} ->
      assert {:ok, atom_form} = Operation.new("external_op_0001", name, payload)
      assert {:ok, string_form} = Operation.new("external_op_0001", to_string(name), payload)
      assert atom_form.fingerprint == string_form.fingerprint
    end)
  end

  test "rejects malformed request keys, unknown names, loose payloads, and invalid UUIDs" do
    assert Operation.new("short", :end_session, %{}) == {:error, :invalid_request_key}
    assert Operation.new("external_op_0001", :invented, %{}) == {:error, :unknown_operation}

    assert Operation.new("external_op_0001", :participant_leave, %{"extra" => true}) ==
             {:error, :invalid_payload}

    assert Operation.new("external_op_0001", :mute_participant, %{
             "participantSessionId" => "not-a-uuid"
           }) == {:error, :invalid_payload}

    assert Operation.new("external_op_0001", :maximum_duration_expired, %{}) ==
             {:error, :invalid_payload}
  end
end
