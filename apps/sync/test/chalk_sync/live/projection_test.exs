defmodule ChalkSync.Live.ProjectionTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Live.Projection

  @participant "00000000-0000-4000-8000-000000000001"
  @participant_two "00000000-0000-4000-8000-000000000002"
  @participant_three "00000000-0000-4000-8000-000000000003"
  @projection "00000000-0000-4000-8000-000000000002"

  test "replaces media with a fresh sequence-zero snapshot and applies exact-next events" do
    item = media_item(false, nil)

    assert {:ok, projection, snapshot} =
             Projection.replace(:media, [item], now_ms: 10, id_generator: fn -> @projection end)

    assert snapshot == %{
             "type" => "projection_snapshot",
             "stream" => "media",
             "projection_id" => @projection,
             "sequence" => 0,
             "items" => [item]
           }

    event = event(:media, @projection, 1, media_item(true, "publication-1"))
    assert {:ok, projection} = Projection.apply_event(projection, event, 11)
    assert projection.sequence == 1
    assert [media] = Projection.items(projection)
    assert media["enabled"]

    replacement_id = "00000000-0000-4000-8000-000000000003"

    assert {:ok, replacement, replacement_frame} =
             Projection.replace_latest(projection,
               now_ms: 12,
               id_generator: fn -> replacement_id end
             )

    assert replacement.projection_id == replacement_id
    assert replacement.sequence == 0
    assert replacement_frame["projection_id"] == replacement_id
    assert replacement_frame["sequence"] == 0

    assert {:error, :stale_event} = Projection.apply_event(projection, event, 12)

    assert {:error, :stale_event} =
             Projection.apply_event(projection, %{event | "sequence" => 3}, 12)
  end

  test "rejects old projection ids, expired projections, invalid invariants, and duplicate keys" do
    assert {:error, :invalid_item} =
             Projection.replace(:media, [media_item(true, nil)],
               id_generator: fn -> @projection end
             )

    assert {:error, :duplicate_item} =
             Projection.replace(:media, [media_item(false, nil), media_item(false, nil)],
               id_generator: fn -> @projection end
             )

    assert {:ok, projection, _snapshot} =
             Projection.replace(:presence, [presence_item("connected", false, false)],
               now_ms: 100,
               max_age_ms: 30_000,
               id_generator: fn -> @projection end
             )

    stale_id = "00000000-0000-4000-8000-000000000003"

    assert {:error, :stale_projection} =
             Projection.apply_event(
               projection,
               event(:presence, stale_id, 1, presence_item("connected", true, true)),
               101
             )

    assert {:error, :stale_projection} =
             Projection.apply_event(
               projection,
               event(:presence, @projection, 1, presence_item("connected", true, true)),
               30_100
             )

    assert {:error, :invalid_item} =
             Projection.replace(:presence, [presence_item("disconnected", true, false)],
               id_generator: fn -> @projection end
             )
  end

  test "enforces stream item and encoded snapshot bounds" do
    items =
      for index <- 1..501 do
        %{
          "participant_session_id" =>
            "00000000-0000-4000-8000-#{index |> Integer.to_string() |> String.pad_leading(12, "0")}",
          "state" => "connected",
          "speaking" => false,
          "active_speaker" => false
        }
      end

    assert {:error, :item_limit} = Projection.replace(:presence, items)

    oversized = media_item(true, String.duplicate("x", 257))
    assert {:error, :invalid_item} = Projection.replace(:media, [oversized])
  end

  test "reconciles media additions, changes, removals, and repeated tombstones" do
    existing = media_item_for(@participant, "camera", true, "publication-1")
    added = media_item_for(@participant_two, "screen", true, "publication-2")

    assert {:ok, projection, _snapshot} =
             Projection.replace(:media, [existing],
               now_ms: 10,
               id_generator: fn -> @projection end
             )

    assert {:ok, projection, [change, addition]} =
             Projection.reconcile(
               projection,
               [media_item_for(@participant, "camera", true, "publication-3"), added],
               now_ms: 11
             )

    assert change["sequence"] == 1
    assert change["item"]["publication_id"] == "publication-3"
    assert addition["sequence"] == 2
    assert addition["item"] == added

    assert {:ok, projection, [removal, added_removal]} =
             Projection.reconcile(projection, [], now_ms: 12)

    assert removal["sequence"] == 3
    assert removal["item"] == media_item_for(@participant, "camera", false, nil)
    assert removal["item"]["publication_id"] == nil
    assert added_removal["sequence"] == 4
    assert added_removal["item"] == media_item_for(@participant_two, "screen", false, nil)

    assert {:ok, ^projection, []} = Projection.reconcile(projection, [], now_ms: 13)
  end

  test "reconciles missing presence into a disconnected tombstone" do
    connected = presence_item_for(@participant, "connected", true, true)

    assert {:ok, projection, _snapshot} =
             Projection.replace(:presence, [connected],
               now_ms: 10,
               id_generator: fn -> @projection end
             )

    assert {:ok, projection, [event]} = Projection.reconcile(projection, [], now_ms: 11)
    assert event["sequence"] == 1
    assert event["item"] == presence_item_for(@participant, "disconnected", false, false)

    assert {:ok, ^projection, []} = Projection.reconcile(projection, [], now_ms: 12)
  end

  test "sorts multiple changes by item key and assigns exact next sequences" do
    participant_two = @participant_two
    participant_three = @participant_three
    camera = media_item_for(@participant, "camera", true, "camera-1")
    microphone = media_item_for(participant_two, "microphone", true, "microphone-1")

    assert {:ok, projection, _snapshot} =
             Projection.replace(:media, [microphone, camera],
               now_ms: 10,
               id_generator: fn -> @projection end
             )

    desired = [
      media_item_for(@participant, "camera", true, "camera-2"),
      media_item_for(participant_three, "screen", true, "screen-1")
    ]

    assert {:ok, next, [first, second, third]} =
             Projection.reconcile(projection, desired, now_ms: 11)

    assert first["sequence"] == 1
    assert first["item"]["participant_session_id"] == @participant
    assert first["item"]["source"] == "camera"
    assert second["sequence"] == 2
    assert second["item"]["participant_session_id"] == participant_two
    assert second["item"]["source"] == "microphone"
    assert second["item"]["enabled"] == false
    assert third["sequence"] == 3
    assert third["item"]["participant_session_id"] == participant_three
    assert third["item"]["source"] == "screen"
    assert next.sequence == 3
  end

  test "rotates to the canonical desired list when tombstones would exceed the bound" do
    initial_items =
      for index <- 1..500 do
        presence_item_for(participant_id(index), "connected", false, false)
      end

    replacement_id = "00000000-0000-4000-8000-000000000003"
    desired = [presence_item_for(participant_id(501), "connected", false, false)]

    assert {:ok, projection, _snapshot} =
             Projection.replace(:presence, initial_items,
               now_ms: 10,
               id_generator: fn -> @projection end
             )

    assert {:ok, replacement, [snapshot]} =
             Projection.reconcile(projection, desired,
               now_ms: 11,
               id_generator: fn -> replacement_id end
             )

    assert replacement.projection_id == replacement_id
    assert replacement.sequence == 0
    assert snapshot["type"] == "projection_snapshot"
    assert snapshot["projection_id"] == replacement_id
    assert snapshot["sequence"] == 0
    assert snapshot["items"] == desired
  end

  test "rotates an aged projection to a fresh canonical snapshot" do
    current = media_item_for(@participant, "camera", true, "publication-1")
    desired = [media_item_for(@participant_two, "screen", true, "publication-2")]
    replacement_id = "00000000-0000-4000-8000-000000000003"

    assert {:ok, projection, _snapshot} =
             Projection.replace(:media, [current],
               now_ms: 10,
               id_generator: fn -> @projection end
             )

    assert {:ok, replacement, [snapshot]} =
             Projection.reconcile(projection, desired,
               now_ms: 30_010,
               id_generator: fn -> replacement_id end
             )

    assert replacement.projection_id == replacement_id
    assert replacement.sequence == 0
    assert replacement.created_at_ms == 30_010
    assert snapshot["type"] == "projection_snapshot"
    assert snapshot["projection_id"] == replacement_id
    assert snapshot["sequence"] == 0
    assert snapshot["items"] == desired
  end

  defp media_item(enabled, publication_id) do
    %{
      "participant_session_id" => @participant,
      "source" => "camera",
      "enabled" => enabled,
      "publication_id" => publication_id
    }
  end

  defp media_item_for(participant, source, enabled, publication_id) do
    %{
      "participant_session_id" => participant,
      "source" => source,
      "enabled" => enabled,
      "publication_id" => publication_id
    }
  end

  defp presence_item(state, speaking, active_speaker) do
    %{
      "participant_session_id" => @participant,
      "state" => state,
      "speaking" => speaking,
      "active_speaker" => active_speaker
    }
  end

  defp presence_item_for(participant, state, speaking, active_speaker) do
    %{
      "participant_session_id" => participant,
      "state" => state,
      "speaking" => speaking,
      "active_speaker" => active_speaker
    }
  end

  defp participant_id(index) do
    "00000000-0000-4000-8000-" <> String.pad_leading(Integer.to_string(index), 12, "0")
  end

  defp event(stream, projection_id, sequence, item) do
    %{
      "type" => "projection_event",
      "stream" => Atom.to_string(stream),
      "projection_id" => projection_id,
      "sequence" => sequence,
      "item" => item
    }
  end
end
