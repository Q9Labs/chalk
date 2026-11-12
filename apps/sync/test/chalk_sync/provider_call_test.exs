defmodule ChalkSync.ProviderCallTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane, as: BridgeMediaPlane
  alias ChalkSync.ProviderBridge.RecordingPlane, as: BridgeRecordingPlane
  alias ChalkSync.ProviderCall

  defmodule PlainAdapter do
    @moduledoc false
  end

  setup do
    {:ok, client: Client.new!(base_url: "http://localhost:4000")}
  end

  test "a plane without a with_call callback is left as it was" do
    plane = {PlainAdapter, :adapter}

    refute ProviderCall.contextual?(plane)
    assert ProviderCall.attach(plane, %{control_revision: 3}) == plane
    assert ProviderCall.attach(nil, %{control_revision: 3}) == nil
  end

  test "the media bridge takes headers, participant generation and control revision", %{
    client: client
  } do
    plane = {BridgeMediaPlane, BridgeMediaPlane.new!(client)}
    assert ProviderCall.contextual?(plane)

    {BridgeMediaPlane, adapter} =
      ProviderCall.attach(plane, %{
        headers: %{"traceparent" => "00-a-b-01"},
        participant_id: "p-1",
        participant_generation: 4,
        control_revision: 9
      })

    assert adapter.context == %{"traceparent" => "00-a-b-01"}
    assert adapter.control_revision == 9
    assert adapter.participant_generation_resolver.(:episode, "p-1") == 4
    assert adapter.participant_generation_resolver.(:episode, "other") == nil
  end

  test "attaching one fact keeps the facts attached before", %{client: client} do
    plane = {BridgeMediaPlane, BridgeMediaPlane.new!(client)}

    {BridgeMediaPlane, adapter} =
      plane
      |> ProviderCall.attach(%{participant_id: "p-1", participant_generation: 4})
      |> ProviderCall.attach(%{control_revision: 9})

    assert adapter.control_revision == 9
    assert adapter.participant_generation_resolver.(:episode, "p-1") == 4
  end

  test "the recording bridge takes headers and the operation payload", %{client: client} do
    plane = {BridgeRecordingPlane, BridgeRecordingPlane.new!(client)}

    {BridgeRecordingPlane, adapter} =
      ProviderCall.attach(plane, %{headers: %{"traceparent" => "00-a-b-01"}, payload: %{"k" => 1}})

    assert adapter.context == %{"traceparent" => "00-a-b-01"}
    assert adapter.operation_payload == %{"k" => 1}
  end
end
