defmodule ChalkSync.Fanout.Collaboration.PostgresNotificationsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Fanout.Collaboration.PostgresNotifications

  test "decodes a payload-free durable head hint" do
    payload =
      JSON.encode!(%{
        "kind" => "chat_head",
        "tenant_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
        "space_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
        "episode_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22",
        "head" => %{"head_sequence" => "42", "retained_floor_sequence" => "7"}
      })

    assert {:ok, {:chat_head, episode, frame}} =
             PostgresNotifications.decode_notification(
               PostgresNotifications.head_channel(),
               payload
             )

    assert episode.episode_id == "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"

    assert frame == %{
             "type" => "chat_head",
             "head_sequence" => "42",
             "retained_floor_sequence" => "7"
           }
  end

  test "rejects content-bearing or malformed head notifications" do
    payload =
      JSON.encode!(%{
        "kind" => "chat_head",
        "tenant_id" => "not-a-uuid",
        "space_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
        "episode_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22",
        "head" => %{"head_sequence" => "42", "retained_floor_sequence" => "7"},
        "text" => "must not fan out"
      })

    assert {:error, :invalid_payload} =
             PostgresNotifications.decode_notification(
               PostgresNotifications.head_channel(),
               payload
             )
  end
end
