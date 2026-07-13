defmodule ChalkSync.Webhooks.EventTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Webhooks.Event

  @fixture_path Path.expand("../../../../../contract/webhooks/v1/fixtures.json", __DIR__)
  @tenant_id "10000000-0000-4000-8000-000000000001"
  @room_id "20000000-0000-4000-8000-000000000001"
  @session_id "30000000-0000-4000-8000-000000000001"
  @participant_id "40000000-0000-4000-8000-000000000001"
  @user_id "50000000-0000-4000-8000-000000000001"

  test "participant joined matches the shared Unicode fixture byte for byte" do
    object = %{
      id: @participant_id,
      user_id: @user_id,
      room_id: @room_id,
      session_id: @session_id,
      name: "Ada – <&> \"東京\" \\",
      status: "active",
      joined_at: datetime("2026-07-12T18:05:00.000999Z"),
      left_at: nil,
      updated_at: datetime("2026-07-12T18:05:00.000999Z")
    }

    assert Event.encode!(
             "00000000-0000-4000-8000-000000000007",
             "participant.joined",
             @tenant_id,
             object.updated_at,
             object
           ) == fixture("participant.joined")
  end

  test "participant left matches the shared fixture byte for byte" do
    object = %{
      id: @participant_id,
      user_id: @user_id,
      room_id: @room_id,
      session_id: @session_id,
      name: "Ada – 東京",
      status: "left",
      joined_at: datetime("2026-07-12T18:05:00.000Z"),
      left_at: datetime("2026-07-12T19:00:00.000Z"),
      updated_at: datetime("2026-07-12T19:00:00.000Z")
    }

    assert Event.encode!(
             "00000000-0000-4000-8000-000000000008",
             "participant.left",
             @tenant_id,
             object.updated_at,
             object
           ) == fixture("participant.left")
  end

  test "session ended matches the shared fixture byte for byte" do
    object = %{
      id: @session_id,
      room_id: @room_id,
      status: "ended",
      started_at: datetime("2026-07-12T18:04:00.000Z"),
      ended_at: datetime("2026-07-12T19:04:00.000Z"),
      created_at: datetime("2026-07-12T18:04:00.000Z"),
      updated_at: datetime("2026-07-12T19:04:00.000Z")
    }

    assert Event.encode!(
             "00000000-0000-4000-8000-000000000006",
             "session.ended",
             @tenant_id,
             object.updated_at,
             object
           ) == fixture("session.ended")
  end

  test "rejects snapshots outside the v1 event-specific contract" do
    joined = participant_object("active", nil)
    left = participant_object("left", datetime("2026-07-12T19:00:00.000Z"))
    session = session_object()

    invalid = [
      {"participant.joined", %{joined | id: nil}, joined.joined_at},
      {"participant.joined", %{joined | id: "00000000-0000-0000-0000-000000000000"},
       joined.joined_at},
      {"participant.joined", %{joined | status: "left"}, joined.joined_at},
      {"participant.joined", %{joined | joined_at: nil}, joined.joined_at},
      {"participant.joined", %{joined | left_at: left.left_at}, joined.joined_at},
      {"participant.left", %{left | status: "active"}, left.left_at},
      {"participant.left", %{left | left_at: nil}, left.left_at},
      {"session.ended", %{session | status: "active"}, session.ended_at},
      {"session.ended", %{session | ended_at: nil}, session.ended_at},
      {"session.ended", %{session | created_at: nil}, session.ended_at}
    ]

    Enum.each(invalid, fn {event_name, object, occurred_at} ->
      assert_raise ArgumentError, fn ->
        Event.encode!(
          "00000000-0000-4000-8000-000000000009",
          event_name,
          @tenant_id,
          occurred_at,
          object
        )
      end
    end)

    assert_raise ArgumentError, fn ->
      Event.encode!(
        "not-a-v4-uuid",
        "participant.joined",
        @tenant_id,
        joined.joined_at,
        joined
      )
    end
  end

  defp participant_object(status, left_at) do
    %{
      id: @participant_id,
      user_id: @user_id,
      room_id: @room_id,
      session_id: @session_id,
      name: "Ada",
      status: status,
      joined_at: datetime("2026-07-12T18:05:00.000Z"),
      left_at: left_at,
      updated_at: datetime("2026-07-12T20:00:00.000Z")
    }
  end

  defp session_object do
    %{
      id: @session_id,
      room_id: @room_id,
      status: "ended",
      started_at: datetime("2026-07-12T18:04:00.000Z"),
      ended_at: datetime("2026-07-12T19:04:00.000Z"),
      created_at: datetime("2026-07-12T18:04:00.000Z"),
      updated_at: datetime("2026-07-12T20:04:00.000Z")
    }
  end

  defp fixture(event_name) do
    @fixture_path
    |> File.read!()
    |> JSON.decode!()
    |> Map.fetch!("fixtures")
    |> Enum.find(&(&1["event"] == event_name))
    |> Map.fetch!("body_utf8")
  end

  defp datetime(value), do: value |> DateTime.from_iso8601() |> elem(1)
end
