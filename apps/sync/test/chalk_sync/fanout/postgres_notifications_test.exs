defmodule ChalkSync.Fanout.PostgresNotificationsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Fanout.PostgresNotifications
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID

  test "a committed media publication notification prompts the local Episode projection" do
    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    {:ok, _} =
      Registry.register(
        ChalkSync.Episodes.Registry,
        EpisodeKey.authority_key(episode),
        nil
      )

    notification_ref = make_ref()

    state = %{
      notifications: self(),
      publication_ref: notification_ref,
      received_count: 0,
      malformed_count: 0,
      last_received_at_ms: nil
    }

    payload = "#{episode.tenant_id}:#{episode.space_id}:#{episode.episode_id}"

    assert {:noreply, %{received_count: 1}} =
             PostgresNotifications.handle_info(
               {:notification, self(), notification_ref, "chalk_media_publications", payload},
               state
             )

    assert_receive {:"$gen_cast", :publication_observed}
  end
end
