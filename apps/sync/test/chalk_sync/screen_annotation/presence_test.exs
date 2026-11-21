defmodule ChalkSync.ScreenAnnotation.PresenceTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ScreenAnnotation.Presence
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID

  test "control changes discard old samples and require a fresh witness before relaying" do
    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    viewer = %{episode: episode, participant_id: UUID.generate()}
    actor = UUID.generate()
    layer = UUID.generate()
    now = System.system_time(:millisecond)
    witness = %{layer: layer, fence: 1, until: now + 10_000}
    old_epoch = Presence.begin_refresh(viewer)
    assert :ok = Presence.confirm(old_epoch, witness)

    stale_sample = sample(layer, 1, actor, now)
    Presence.relay(episode, stale_sample)
    assert_receive :annotation_presence_ready

    Presence.change(episode, true)
    assert_receive :annotation_changed
    assert [] = Presence.take()
    assert :stale = Presence.confirm(old_epoch, witness)

    current_sample = sample(layer, 2, actor, now)
    Presence.relay(episode, stale_sample)
    Presence.relay(episode, current_sample)
    assert [] = Presence.take()

    current_epoch = Presence.begin_refresh(viewer)
    assert :ok = Presence.confirm(current_epoch, %{witness | fence: 2})
    Presence.relay(%{episode | tenant_id: UUID.generate()}, current_sample)
    Presence.relay(episode, stale_sample)
    assert [] = Presence.take()

    Presence.relay(episode, current_sample)
    newer = %{current_sample | "server_at_ms" => now + 1}
    Presence.relay(episode, newer)
    assert [^newer] = Presence.take()
    assert [] = Presence.take()
    Presence.leave()
  end

  defp sample(layer, fence, actor, now) do
    %{
      "layer_id" => layer,
      "fence" => fence,
      "author" => %{"participant_id" => actor},
      "server_at_ms" => now,
      "expires_at_ms" => now + 1_000,
      "cursor" => %{"x" => 1, "y" => 1, "kind" => "pointer"},
      "draft" => nil
    }
  end
end
