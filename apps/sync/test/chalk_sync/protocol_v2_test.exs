defmodule ChalkSync.ProtocolV2Test do
  use ExUnit.Case, async: true

  alias ChalkSync.ProtocolV2
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Stateholder.SessionKey

  @participant_id "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21"
  @session_id "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c25"

  test "decodes a strict hello and converts the wire digest" do
    digest = :crypto.strong_rand_bytes(32)

    frame =
      JSON.encode!(%{
        "type" => "hello",
        "protocol" => 2,
        "token" => "signed-token",
        "streams" => %{
          "control" => %{
            "cursor" => %{
              "revision" => 3,
              "state_schema_version" => 1,
              "state_digest" => Base.encode16(digest, case: :lower)
            }
          }
        }
      })

    assert {:ok, {:hello, %{token: "signed-token", cursor: cursor}}} = ProtocolV2.decode(frame)
    assert cursor == %{revision: 3, state_schema_version: 1, digest: digest}
  end

  test "rejects oversized input before JSON decoding" do
    oversized = String.duplicate("x", 65_537)
    assert {:error, :frame_too_large} = ProtocolV2.decode(oversized)
  end

  test "decodes only a strict cumulative live delivery ACK" do
    digest = String.duplicate("a", 64)

    assert {:ok, {:delivery_ack, %{stream: :control, revision: 7, state_digest: ^digest}}} =
             ProtocolV2.decode(
               JSON.encode!(%{
                 "type" => "delivery_ack",
                 "stream" => "control",
                 "revision" => 7,
                 "state_digest" => digest
               })
             )

    assert {:error, :invalid_delivery_ack} =
             ProtocolV2.decode(
               JSON.encode!(%{
                 "type" => "delivery_ack",
                 "stream" => "control",
                 "revision" => 7,
                 "state_digest" => digest,
                 "extra" => true
               })
             )
  end

  test "decodes only an exact recovery ACK and accepts revision zero" do
    digest = String.duplicate("a", 64)
    recovery_id = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"

    assert {:ok,
            {:recovery_ack, %{recovery_id: ^recovery_id, revision: 0, state_digest: ^digest}}} =
             ProtocolV2.decode(
               JSON.encode!(%{
                 "type" => "recovery_ack",
                 "recovery_id" => recovery_id,
                 "revision" => 0,
                 "state_digest" => digest
               })
             )

    for invalid <- [
          %{
            "type" => "recovery_ack",
            "recovery_id" => recovery_id,
            "revision" => -1,
            "state_digest" => digest
          },
          %{
            "type" => "recovery_ack",
            "recovery_id" => recovery_id,
            "revision" => 0,
            "state_digest" => digest,
            "extra" => true
          }
        ] do
      assert {:error, :invalid_recovery_ack} = ProtocolV2.decode(JSON.encode!(invalid))
    end
  end

  test "renders snapshot recovery with the digest and completion barrier" do
    state = participant_state()
    digest = Reducer.digest(state)

    recovery = %Recovery{
      mode: :snapshot,
      head: %{revision: state.revision, state_schema_version: 1, digest: digest},
      snapshot: Reducer.snapshot(state),
      events: []
    }

    recovery_id = ProtocolV2.recovery_id()
    welcome_json = ProtocolV2.recovery_welcome(identity(), recovery, recovery_id)
    complete_json = ProtocolV2.recovery_complete(recovery, recovery_id)
    {:ok, welcome} = JSON.decode(welcome_json)
    {:ok, complete} = JSON.decode(complete_json)

    assert welcome["mode"] == "snapshot"
    assert welcome["snapshot"]["state_digest"] == Base.encode16(digest, case: :lower)
    assert complete["type"] == "recovery_complete"
    assert complete["head"] == welcome["head"]
  end

  test "paginates replay without breaking continuity" do
    digest = :crypto.strong_rand_bytes(32)

    events =
      Enum.map(1..129, fn revision ->
        %{
          event_id: uuid(revision),
          name: if(rem(revision, 2) == 0, do: "hand_lowered", else: "hand_raised"),
          base_revision: revision - 1,
          revision: revision,
          schema_version: 1,
          resulting_state_digest: digest,
          payload: %{"participant_session_id" => @participant_id},
          command_id: "command-#{String.pad_leading(Integer.to_string(revision), 12, "0")}",
          lifecycle_intent_id: nil
        }
      end)

    recovery_id = ProtocolV2.recovery_id()
    assert {:ok, first_json, 128} = ProtocolV2.recovery_page(events, recovery_id)
    assert {:ok, second_json, 129} = ProtocolV2.recovery_page(Enum.drop(events, 128), recovery_id)
    pages = Enum.map([first_json, second_json], &JSON.decode!/1)

    assert Enum.map(pages, &length(&1["events"])) == [128, 1]
    assert Enum.map(pages, &{&1["first_revision"], &1["last_revision"]}) == [{1, 128}, {129, 129}]
  end

  test "encodes terminal decisions and retryable uncertainty separately" do
    decision = %Decision{
      command_id: "command-000000001",
      result: :duplicate,
      event_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      revision: 6
    }

    assert {:ok, %{"type" => "ack", "result" => "duplicate"}} =
             decision |> ProtocolV2.ack() |> JSON.decode()

    assert {:ok, %{"type" => "retryable_error", "code" => "decision_unavailable"}} =
             "command-000000001"
             |> ProtocolV2.retryable(:decision_unavailable)
             |> JSON.decode()
  end

  defp participant_state do
    state = Reducer.new(@session_id)

    {:ok, _event, next} =
      Reducer.apply_lifecycle(state, :participant_joined, %{
        "participant_session_id" => @participant_id,
        "display_name" => "Ada"
      })

    next
  end

  defp identity do
    %Identity{
      session: %SessionKey{
        tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c26",
        room_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c27",
        session_id: @session_id
      },
      participant_session_id: @participant_id,
      participant_session_generation: 1,
      capabilities: ["control:hand"]
    }
  end

  defp uuid(value) do
    suffix = value |> Integer.to_string(16) |> String.pad_leading(12, "0")
    "018f2f65-2a77-7a44-8e9a-#{suffix}"
  end
end
