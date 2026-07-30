defmodule ChalkSync.RoomActions.FanoutTest do
  use ExUnit.Case, async: true

  alias ChalkSync.RoomActions.Fanout
  alias ChalkSync.Stateholder.SessionKey

  defmodule Transport do
    @behaviour ChalkSync.RoomActions.Fanout.Transport

    @impl true
    def publish_chat_head(test, session, head) do
      send(test, {:published_head, session, head})
      :ok
    end

    @impl true
    def publish_reaction(test, session, event) do
      send(test, {:published_reaction, session, event})
      :ok
    end

    @impl true
    def publish_chat_read_receipt(test, session, receipt) do
      send(test, {:published_read_receipt, session, receipt})
      :ok
    end
  end

  test "delivers locally, invokes cross-replica transport, and unsubscribes" do
    fanout =
      start_supervised!({Fanout, name: nil, transport: {Transport, self()}})

    session = session()
    assert :ok = Fanout.subscribe(fanout, session, self())

    head = %{head_sequence: "8", retained_floor_sequence: "2"}
    assert :ok = Fanout.publish_chat_head(fanout, session, head)

    assert_receive {:room_action_frame,
                    %{
                      "type" => "chat_head",
                      "head_sequence" => "8",
                      "retained_floor_sequence" => "2"
                    }}

    assert_receive {:published_head, ^session, ^head}

    event = %{"type" => "room_reaction", "event_id" => "event"}
    assert :ok = Fanout.publish_reaction(fanout, session, event)
    assert_receive {:room_action_frame, ^event}
    assert_receive {:published_reaction, ^session, ^event}

    receipt = %{
      "type" => "chat_read_receipt",
      "participant_session_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      "participant_session_generation" => 1,
      "sequence" => "8",
      "read_at" => "2026-07-29T14:01:00.000Z"
    }

    assert :ok = Fanout.publish_chat_read_receipt(fanout, session, receipt)
    assert_receive {:room_action_frame, ^receipt}
    assert_receive {:published_read_receipt, ^session, ^receipt}

    assert :ok = Fanout.unsubscribe(fanout, session, self())
    assert :ok = Fanout.publish_reaction(fanout, session, event)
    refute_receive {:room_action_frame, ^event}
    assert %{sessions: 0, subscribers: 0} = Fanout.stats(fanout)
  end

  test "bounds sessions and subscribers and removes dead subscribers" do
    fanout =
      start_supervised!({Fanout, name: nil, session_limit: 1, subscriber_limit: 1})

    session = session()
    subscriber = spawn(fn -> Process.sleep(:infinity) end)

    assert :ok = Fanout.subscribe(fanout, session, subscriber)
    assert {:error, :overloaded} = Fanout.subscribe(fanout, session, self())

    other = %{session | session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c25"}
    assert {:error, :overloaded} = Fanout.subscribe(fanout, other, self())

    Process.exit(subscriber, :kill)
    assert_eventually(fn -> Fanout.stats(fanout) == %{sessions: 0, subscribers: 0} end)
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

  defp session do
    %SessionKey{
      tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
      room_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
      session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"
    }
  end
end
