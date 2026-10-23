defmodule ChalkSync.WhiteboardV1.ViewOwnerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.ViewOwner

  setup do
    episode = UUID.generate()
    person = UUID.generate()
    {:ok, owner, id, []} = ViewOwner.join(episode, person)
    %{episode: episode, person: person, owner: owner, id: id, stream: UUID.generate()}
  end

  test "two tabs share one stamper, retries apply once, and heartbeats do not move followers",
       c do
    a1 = frame(c.person, 10)
    a2 = frame(c.person, 20)
    b1 = frame(c.person, 30)
    other_tab = UUID.generate()
    assert :ok = ViewOwner.move(c.owner, a1, input(c.stream, 1))
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 1, "x" => 10}}
    assert :ok = ViewOwner.move(c.owner, b1, input(other_tab, 1))
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 2, "x" => 30}}
    assert :ok = ViewOwner.move(c.owner, a2, input(c.stream, 2))
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 3, "x" => 20}}
    assert :ok = ViewOwner.move(c.owner, b1, input(other_tab, 1))
    assert :ok = ViewOwner.move(c.owner, b1, %{input(other_tab, 2) | move: false})
    refute_receive {:whiteboard_v1_frame, _}
  end

  test "joining mid-move gets the canonical snapshot followed by the newer move", c do
    :ok = ViewOwner.move(c.owner, frame(c.person, 10), input(c.stream, 1))
    assert_receive {:whiteboard_v1_frame, _}
    {:ok, owner, id, [snapshot]} = ViewOwner.join(c.episode, UUID.generate())
    assert owner == c.owner
    assert id == c.id
    assert snapshot["owner_sequence"] == 1
    assert snapshot["bring"] == false
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 1}}
    :ok = ViewOwner.move(owner, frame(c.person, 20), input(c.stream, 2))
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 2, "x" => 20}}
  end

  test "owner restart replaces the snapshot identity and restarts its counter", c do
    :ok = ViewOwner.move(c.owner, frame(c.person, 10), input(c.stream, 1))
    ref = Process.monitor(c.owner)
    Process.exit(c.owner, :kill)
    assert_receive {:DOWN, ^ref, :process, _, :killed}
    {:ok, next, id, []} = ViewOwner.join(c.episode, c.person)
    assert id != c.id
    :ok = ViewOwner.move(next, frame(c.person, 20), input(c.stream, 2))
    assert_receive {:whiteboard_v1_frame, %{"owner_id" => ^id, "owner_sequence" => 1}}
  end

  test "relays use the owner's geometry, never the submitted rectangle", c do
    source = UUID.generate()
    {:ok, _, _, []} = ViewOwner.join(c.episode, source)
    :ok = ViewOwner.move(c.owner, frame(source, 10), input(UUID.generate(), 1))
    assert_receive {:whiteboard_v1_frame, %{"x" => 10}}
    relay = Map.merge(input(c.stream, 1), %{move: false, origin_participant_id: source})
    :ok = ViewOwner.move(c.owner, frame(c.person, 900), relay)
    person = c.person
    assert_receive {:whiteboard_v1_frame, %{"participant_id" => ^person, "x" => 10}}
  end

  test "legacy tab keepalives cannot reclaim the other tab's real move", c do
    tab_a = %{origin_epoch: UUID.generate()}
    tab_b = %{origin_epoch: UUID.generate()}
    :ok = ViewOwner.move(c.owner, frame(c.person, 10), tab_a)
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 1}}
    :ok = ViewOwner.move(c.owner, frame(c.person, 20), tab_b)
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 2}}
    :ok = ViewOwner.move(c.owner, frame(c.person, 10), tab_a)
    refute_receive {:whiteboard_v1_frame, _}
  end

  test "a later heartbeat cannot fence out a real move's retry", c do
    :ok = ViewOwner.move(c.owner, frame(c.person, 10), %{input(c.stream, 2) | move: false})
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 1}}
    :ok = ViewOwner.move(c.owner, frame(c.person, 20), input(c.stream, 1))
    assert_receive {:whiteboard_v1_frame, %{"owner_sequence" => 2, "x" => 20}}
  end

  for protocol <- [:owner, :legacy] do
    @protocol protocol
    test "#{protocol} relay heartbeats cannot reclaim another tab's real move", c do
      source = UUID.generate()
      test = self()

      socket =
        spawn(fn ->
          {:ok, owner, _, _} = ViewOwner.join(c.episode, source)
          :ok = ViewOwner.move(owner, frame(source, 10), input(UUID.generate(), 1))
          send(test, :source_moved)
          receive do: (:stop -> :ok)
        end)

      on_exit(fn -> Process.exit(socket, :kill) end)
      assert_receive :source_moved
      assert_receive {:whiteboard_v1_frame, %{"participant_id" => ^source}}

      relay =
        if @protocol == :owner,
          do: Map.put(input(c.stream, 1), :move, false),
          else: %{origin_epoch: c.stream}

      relay = Map.put(relay, :origin_participant_id, source)
      :ok = ViewOwner.move(c.owner, frame(c.person, 900), relay)
      assert_receive {:whiteboard_v1_frame, %{"x" => 10, "owner_sequence" => 1}}
      :ok = ViewOwner.move(c.owner, frame(c.person, 20), input(UUID.generate(), 1))
      assert_receive {:whiteboard_v1_frame, %{"x" => 20, "owner_sequence" => 2}}
      relay = if @protocol == :owner, do: %{relay | input_id: "#{c.stream}:2"}, else: relay
      :ok = ViewOwner.move(c.owner, frame(c.person, 900), relay)
      refute_receive {:whiteboard_v1_frame, _}

      if @protocol == :owner do
        :ok = ViewOwner.move(c.owner, frame(c.person, 30), input(c.stream, 3))
        assert_receive {:whiteboard_v1_frame, %{"x" => 30, "owner_sequence" => 3}}
        :ok = ViewOwner.move(c.owner, frame(c.person, 900), %{relay | input_id: "#{c.stream}:4"})
        assert_receive {:whiteboard_v1_frame, %{"x" => 10, "owner_sequence" => 4}}
      end
    end
  end

  test "the owner stops when the Episode's last socket exits" do
    test = self()
    episode = UUID.generate()

    socket =
      spawn(fn ->
        {:ok, owner, _, []} = ViewOwner.join(episode, UUID.generate())
        send(test, {:joined, owner})

        receive do
          :leave -> :ok
        end
      end)

    on_exit(fn -> if Process.alive?(socket), do: Process.exit(socket, :kill) end)
    assert_receive {:joined, owner}
    ref = Process.monitor(owner)
    send(socket, :leave)
    assert_receive {:DOWN, ^ref, :process, ^owner, :normal}
  end

  defp input(stream, sequence), do: %{input_id: "#{stream}:#{sequence}", move: true}

  defp frame(person, x) do
    %{
      "type" => "view",
      "participant_id" => person,
      "display_name" => "Person",
      "x" => x,
      "y" => 0,
      "width" => 100,
      "height" => 100,
      "bring" => false,
      "occurred_at" => "2026-10-23T00:00:00.000Z"
    }
  end
end
