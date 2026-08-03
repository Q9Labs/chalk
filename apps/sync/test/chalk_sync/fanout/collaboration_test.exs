defmodule ChalkSync.Fanout.CollaborationTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Fanout.Collaboration, as: Fanout
  alias ChalkSync.Stateholder.EpisodeKey

  defmodule Transport do
    @behaviour ChalkSync.Fanout.Collaboration.Transport

    @impl true
    def publish_chat_head(test, episode, head) do
      send(test, {:published_head, episode, head})
      :ok
    end

    @impl true
    def publish_reaction(test, episode, event) do
      send(test, {:published_reaction, episode, event})
      :ok
    end

    @impl true
    def publish_chat_read_receipt(test, episode, receipt) do
      send(test, {:published_read_receipt, episode, receipt})
      :ok
    end
  end

  test "delivers locally, invokes cross-replica transport, and unsubscribes" do
    fanout =
      start_supervised!({Fanout, name: nil, transport: {Transport, self()}})

    episode = episode()
    assert :ok = Fanout.subscribe(fanout, episode, self())

    head = %{head_sequence: "8", retained_floor_sequence: "2"}
    assert :ok = Fanout.publish_chat_head(fanout, episode, head)

    assert_receive {:collaboration_frame,
                    %{
                      "type" => "chat_head",
                      "head_sequence" => "8",
                      "retained_floor_sequence" => "2"
                    }}

    assert_receive {:published_head, ^episode, ^head}

    event = %{"type" => "reaction", "event_id" => "event"}
    assert :ok = Fanout.publish_reaction(fanout, episode, event)
    assert_receive {:collaboration_frame, ^event}
    assert_receive {:published_reaction, ^episode, ^event}

    receipt = %{
      "type" => "chat_read_receipt",
      "participant_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      "participant_generation" => 1,
      "sequence" => "8",
      "read_at" => "2026-07-29T14:01:00.000Z"
    }

    assert :ok = Fanout.publish_chat_read_receipt(fanout, episode, receipt)
    assert_receive {:collaboration_frame, ^receipt}
    assert_receive {:published_read_receipt, ^episode, ^receipt}

    assert :ok = Fanout.unsubscribe(fanout, episode, self())
    assert :ok = Fanout.publish_reaction(fanout, episode, event)
    refute_receive {:collaboration_frame, ^event}
    assert %{episodes: 0, subscribers: 0} = Fanout.stats(fanout)
  end

  test "bounds episodes and subscribers and removes dead subscribers" do
    fanout =
      start_supervised!({Fanout, name: nil, episode_limit: 1, subscriber_limit: 1})

    episode = episode()
    subscriber = spawn(fn -> Process.sleep(:infinity) end)

    assert :ok = Fanout.subscribe(fanout, episode, subscriber)
    assert {:error, :overloaded} = Fanout.subscribe(fanout, episode, self())

    other = %{episode | episode_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c25"}
    assert {:error, :overloaded} = Fanout.subscribe(fanout, other, self())

    Process.exit(subscriber, :kill)
    assert_eventually(fn -> Fanout.stats(fanout) == %{episodes: 0, subscribers: 0} end)
  end

  defp assert_eventually(assertion, attempts \\ 20)

  defp assert_eventually(assertion, attempts) when attempts > 0 do
    if assertion.() do
      :ok
    else
      Process.sleep(5)
      assert_eventually(assertion, attempts - 1)
    end
  end

  defp assert_eventually(assertion, 0), do: assert(assertion.())

  defp episode do
    %EpisodeKey{
      tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
      space_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
      episode_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"
    }
  end
end
