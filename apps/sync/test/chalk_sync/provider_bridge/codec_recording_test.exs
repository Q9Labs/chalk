defmodule ChalkSync.ProviderBridge.CodecRecordingTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ProviderBridge.Codec

  @operation_id "11111111-1111-4111-8111-111111111111"
  @request_payload %{"effect" => "recording.start"}

  test "preserves stable Recording failure reasons" do
    payload = %{
      "operation_id" => @operation_id,
      "effect" => "recording.start",
      "outcome" => "terminal_failure",
      "reason" => "recording_capacity_unavailable"
    }

    assert {:ok, {:terminal_failure, :recording_capacity_unavailable}} =
             Codec.decode_operation_response(payload, @operation_id, @request_payload)
  end

  test "rejects a non-string optional reason" do
    payload = %{
      "operation_id" => @operation_id,
      "effect" => "recording.start",
      "outcome" => "confirmed",
      "reason" => 7
    }

    assert {:error, {:retryable_failure, :malformed_response}} =
             Codec.decode_operation_response(payload, @operation_id, @request_payload)
  end

  test "tenant recording quota HTTP rejection is terminal" do
    body =
      JSON.encode!(%{
        "error" => %{
          "code" => "tenant.recording_limit_reached",
          "message" => "Tenant recording limit reached"
        },
        "reason" => "tenant_recording_limit_reached"
      })

    assert {:error, {:terminal_failure, :tenant_recording_limit_reached}} =
             Codec.normalize_response(409, body, 4096)
  end
end
