defmodule ChalkSync.Live.MediaOffReasonTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Live.Projection
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.UUID

  setup do
    Memory.reset()

    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    host_id = UUID.generate()
    guest_id = UUID.generate()

    :ok =
      Memory.seed_episode(episode, [
        %{id: host_id, generation: 1, display_name: "Host", role: "owner"},
        %{id: guest_id, generation: 1, display_name: "Guest", role: "collaborator"}
      ])

    previous = Application.get_env(:chalk_sync, :media_plane)
    on_exit(fn -> restore_media_plane(previous) end)

    {:ok, episode: episode, host: identity(episode, host_id), guest: identity(episode, guest_id)}
  end

  test "a host mute shows the revision of its stop event even with no publication", ctx do
    observe(ctx, [])

    assert [] = items(ctx.episode)

    revision = mute(ctx)

    assert [
             %{
               "participant_id" => guest_id,
               "source" => "microphone",
               "enabled" => false,
               "publication_id" => nil,
               "off_reason" => "host",
               "off_revision" => ^revision
             }
           ] = items(ctx.episode)

    assert guest_id == ctx.guest.participant_id
  end

  test "a fresh Sync process still shows the host mute from the stateholder", ctx do
    observe(ctx, [])
    revision = mute(ctx)

    assert {:ok, first, _frames} = LiveEpisode.reconcile(LiveEpisode.new(ctx.episode))
    assert {:ok, second, _frames} = LiveEpisode.reconcile(LiveEpisode.new(ctx.episode))

    assert first.media_items == second.media_items
    assert [%{"off_reason" => "host", "off_revision" => ^revision}] = second.media_items
  end

  test "a host mute that finds a listed publication projects the same reason", ctx do
    publication = %{
      participant_id: ctx.guest.participant_id,
      source: :microphone,
      enabled: false,
      publication_id: nil
    }

    observe(ctx, [publication])
    revision = mute(ctx)

    assert [%{"enabled" => false, "off_reason" => "host", "off_revision" => ^revision}] =
             items(ctx.episode)
  end

  test "a plain tombstone carries no reason", ctx do
    observe(ctx, [
      %{
        participant_id: ctx.guest.participant_id,
        source: :microphone,
        enabled: false,
        publication_id: nil
      }
    ])

    assert [item] = items(ctx.episode)

    assert Map.keys(item) |> Enum.sort() == [
             "enabled",
             "participant_id",
             "publication_id",
             "source"
           ]
  end

  test "a device pause says self and never carries a revision", ctx do
    publication_id = "mic-track"

    observe(ctx, [
      %{
        participant_id: ctx.guest.participant_id,
        source: :microphone,
        enabled: true,
        publication_id: publication_id
      }
    ])

    :ok = Memory.set_media_pause(ctx.guest, :microphone, publication_id)

    assert [%{"enabled" => false, "off_reason" => "self"} = item] = items(ctx.episode)
    refute Map.has_key?(item, "off_revision")
  end

  test "a host stop is newer than the device's own pause for the same source", ctx do
    publication_id = "mic-track"

    observe(ctx, [
      %{
        participant_id: ctx.guest.participant_id,
        source: :microphone,
        enabled: true,
        publication_id: publication_id
      }
    ])

    :ok = Memory.set_media_pause(ctx.guest, :microphone, publication_id)
    revision = mute(ctx)

    assert [%{"off_reason" => "host", "off_revision" => ^revision}] = items(ctx.episode)
  end

  describe "item validation" do
    test "the earlier four-key item stays valid in the projection and on the wire" do
      assert {:ok, _projection, _frame} = Projection.replace(:media, [base()])
      assert wire_valid?(base())
    end

    test "each reason is valid only in its own shape" do
      valid = [
        Map.merge(base(), %{"off_reason" => "host", "off_revision" => 7}),
        Map.put(base(), "off_reason", "self"),
        Map.put(base(), "off_reason", "dead")
      ]

      for item <- valid do
        assert {:ok, _projection, _frame} = Projection.replace(:media, [item])
        assert wire_valid?(item)
      end

      invalid = [
        Map.merge(base(), %{"enabled" => true, "publication_id" => "track"})
        |> Map.put("off_reason", "self"),
        Map.put(base(), "off_reason", "host"),
        Map.merge(base(), %{"off_reason" => "self", "off_revision" => 7}),
        Map.merge(base(), %{"off_reason" => "gone", "off_revision" => 7}),
        Map.put(base(), "off_revision", 7),
        Map.merge(base(), %{"off_reason" => "host", "off_revision" => 0})
      ]

      for item <- invalid do
        assert {:error, :invalid_item} = Projection.replace(:media, [item])
        refute wire_valid?(item)
      end
    end

    defp base do
      %{
        "participant_id" => UUID.generate(),
        "source" => "microphone",
        "enabled" => false,
        "publication_id" => nil
      }
    end

    defp wire_valid?(item) do
      GeneratedV1.valid_server_frame?(%{
        "type" => "projection_event",
        "stream" => "media",
        "projection_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c25",
        "sequence" => 1,
        "item" => item
      })
    end
  end

  defp items(episode) do
    assert {:ok, live, _frames} = LiveEpisode.reconcile(LiveEpisode.new(episode))
    live.media_items
  end

  defp mute(ctx) do
    {:ok, operation} =
      Operation.new("off_reason_mute_#{System.unique_integer([:positive])}", :mute_participant, %{
        "participantId" => ctx.guest.participant_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Memory.begin_operation(ctx.host, operation)

    assert {:ok, claimed} = Memory.claim_operations(64)

    {episode, _external} =
      Enum.find(claimed, fn {_episode, candidate} ->
        candidate.external_operation_id == operation_id
      end)

    assert {:ok, _decision} =
             Memory.finalize_operation(
               episode,
               operation_id,
               {:applied, :participant_microphone_stopped,
                %{"participant_id" => ctx.guest.participant_id}}
             )

    assert {:ok, %{status: :applied, applied_revision: revision}} =
             Memory.read_operation(ctx.episode, operation_id)

    revision
  end

  defp observe(_ctx, publications) do
    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{observe_episode_publications: {:ok, publications}}
      )

    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
  end

  defp identity(episode, participant_id) do
    %Identity{episode: episode, participant_id: participant_id, participant_generation: 1}
  end

  defp restore_media_plane(nil), do: Application.delete_env(:chalk_sync, :media_plane)
  defp restore_media_plane(value), do: Application.put_env(:chalk_sync, :media_plane, value)
end
