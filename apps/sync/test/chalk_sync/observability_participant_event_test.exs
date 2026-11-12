defmodule ChalkSync.ObservabilityParticipantEventTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.EpisodeKey

  @participant_id "5f0f7c0e-3b59-4f6a-9d0b-0c3a7d7a1e11"

  setup do
    handler = "participant-event-#{System.unique_integer([:positive])}"
    owner = self()

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _event, _measurements, metadata, _config -> send(owner, {:event, metadata}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)

    {:ok,
     episode: %EpisodeKey{tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1"}}
  end

  test "a Participant event carries the Episode and the hashed Participant, never the raw id", %{
    episode: episode
  } do
    Observability.participant_event(episode, @participant_id, "sync.media.pause", %{
      source: "camera",
      outcome: "confirmed",
      error_code: nil
    })

    assert_receive {:event, %{event: "sync.media.pause", attributes: attributes}}

    assert attributes == %{
             source: "camera",
             outcome: "confirmed",
             tenant_id: "tenant-1",
             episode_id: "episode-1",
             participant_id_hash: Observability.participant_hash(@participant_id)
           }

    refute inspect(attributes) =~ @participant_id
  end

  test "the hash is the SHA-256 the API and the socket spans use" do
    expected = :crypto.hash(:sha256, @participant_id) |> Base.encode16(case: :lower)
    assert Observability.participant_hash(@participant_id) == expected
  end
end
