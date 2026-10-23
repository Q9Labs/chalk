defmodule ChalkSync.WhiteboardV1.ViewOwnerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority
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

    Enum.reduce(1..10, {c.owner, c.id}, fn _, {owner, previous_id} ->
      ref = Process.monitor(owner)
      Process.exit(owner, :kill)
      assert_receive {:DOWN, ^ref, :process, _, :killed}
      {:ok, next, id, []} = ViewOwner.join(c.episode, c.person)
      assert id != previous_id
      :ok = ViewOwner.move(next, frame(c.person, 20), input(c.stream, 2))
      assert_receive {:whiteboard_v1_frame, %{"owner_id" => ^id, "owner_sequence" => 1}}
      {next, id}
    end)
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
          stream = UUID.generate()
          :ok = ViewOwner.move(owner, frame(source, 10), input(stream, 1))
          send(test, :source_moved)

          receive do
            :move_again ->
              :ok = ViewOwner.move(owner, frame(source, 11), input(stream, 2))
              receive do: (:stop -> :ok)
          end
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
      send(socket, :move_again)
      assert_receive {:whiteboard_v1_frame, %{"participant_id" => ^source, "x" => 11}}
      relay = if @protocol == :owner, do: %{relay | input_id: "#{c.stream}:2"}, else: relay
      :ok = ViewOwner.move(c.owner, frame(c.person, 900), relay)
      refute_receive {:whiteboard_v1_frame, _}

      if @protocol == :owner do
        :ok = ViewOwner.move(c.owner, frame(c.person, 30), input(c.stream, 3))
        assert_receive {:whiteboard_v1_frame, %{"x" => 30, "owner_sequence" => 3}}
        selection = %{relay | input_id: "#{c.stream}:4", move: true}
        :ok = ViewOwner.move(c.owner, frame(c.person, 900), selection)
        assert_receive {:whiteboard_v1_frame, %{"x" => 11, "owner_sequence" => 4}}
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

  test "admits all 500 canonical Episode participants", c do
    assert GeneratedWhiteboardV1.limits()["viewPeopleMaxItems"] ==
             Reducer.max_participants()

    for _ <- 2..500 do
      assert {:ok, owner, _, []} = ViewOwner.join(c.episode, UUID.generate())
      assert owner == c.owner
    end

    assert {:error, :overloaded} = ViewOwner.join(c.episode, UUID.generate())
  end

  test "retired people free admission without forgetting uncertain retry receipts", c do
    test = self()
    person = UUID.generate()
    stream = UUID.generate()

    for n <- 1..501 do
      participant = if n == 1, do: person, else: UUID.generate()

      {socket, ref} =
        spawn_monitor(fn ->
          {:ok, owner, _, _} = ViewOwner.join(c.episode, participant)
          if n == 1, do: ViewOwner.move(owner, frame(person, 10), input(stream, 1))
          send(test, :joined)
          receive do: (:leave -> :ok)
        end)

      assert_receive :joined
      send(socket, :leave)
      assert_receive {:DOWN, ^ref, :process, ^socket, :normal}
      assert MapSet.size(:sys.get_state(c.owner).people) == 1
    end

    {:ok, _, _, [_]} = ViewOwner.join(c.episode, person)
    :ok = ViewOwner.move(c.owner, frame(person, 10), input(stream, 1))
    assert :sys.get_state(c.owner).views[person]["owner_sequence"] == 1
  end

  test "an admitted relay can update at stream capacity", c do
    source = UUID.generate()
    {:ok, _, _, []} = ViewOwner.join(c.episode, source)
    source_stream = UUID.generate()
    :ok = ViewOwner.move(c.owner, frame(source, 10), input(source_stream, 1))
    relay = Map.put(input(c.stream, 1), :origin_participant_id, source)
    :ok = ViewOwner.move(c.owner, frame(c.person, 900), relay)

    for n <- 1..1022 do
      assert :ok = ViewOwner.move(c.owner, frame(c.person, n), input(UUID.generate(), 1))
    end

    assert {:error, :overloaded} =
             ViewOwner.move(c.owner, frame(c.person, 999), input(UUID.generate(), 1))

    :ok = ViewOwner.move(c.owner, frame(source, 20), input(source_stream, 2))

    assert :ok =
             ViewOwner.move(c.owner, frame(c.person, 900), %{relay | input_id: "#{c.stream}:2"})

    state = :sys.get_state(c.owner)
    assert state.views[c.person]["x"] == 20
  end

  test "snapshots exclude 600 durable departures but keep a disconnected active person's view" do
    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    active = UUID.generate()
    stream = UUID.generate()
    test = self()
    {:ok, owner, _, []} = ViewOwner.join(episode, UUID.generate())
    publish_then_disconnect(episode, active, stream, test)
    for _ <- 1..600, do: publish_then_disconnect(episode, UUID.generate(), UUID.generate(), test)

    Process.sleep(2)

    Authority.store(
      episode,
      %{status: "active", participants: %{{active, 1} => "active"}},
      System.monotonic_time(:millisecond),
      nil
    )

    {:ok, ^owner, _, snapshot} = ViewOwner.join(episode, UUID.generate())
    assert [%{"participant_id" => ^active, "x" => 10, "owner_sequence" => 1}] = snapshot
    {:ok, ^owner, _, snapshot} = ViewOwner.join(episode, active)
    assert length(snapshot) == 1
    :ok = ViewOwner.move(owner, frame(active, 10), input(stream, 1))
    {:ok, ^owner, _, [%{"owner_sequence" => 1}]} = ViewOwner.join(episode, active)
  end

  test "reversible leaving retains a view, durable left excludes it", c do
    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    {:ok, owner, _, []} = ViewOwner.join(episode, c.person)
    :ok = ViewOwner.move(owner, frame(c.person, 10), input(c.stream, 1))

    for {status, count} <- [{"leaving", 1}, {"left", 0}] do
      Process.sleep(2)

      Authority.store(
        episode,
        %{status: "active", participants: %{{c.person, 1} => status}},
        System.monotonic_time(:millisecond),
        nil
      )

      {:ok, ^owner, _, snapshot} = ViewOwner.join(episode, UUID.generate())
      assert length(snapshot) == count
    end
  end

  test "snapshots keep joins newer than the membership read and compare UUIDs without casing" do
    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    person = String.upcase(UUID.generate())

    Authority.store(
      episode,
      %{status: "active", participants: %{}},
      System.monotonic_time(:millisecond) - 10,
      nil
    )

    {:ok, owner, _, []} = ViewOwner.join(episode, person)
    :ok = ViewOwner.move(owner, frame(person, 10), input(UUID.generate(), 1))
    {:ok, ^owner, _, [%{"participant_id" => ^person}]} = ViewOwner.join(episode, UUID.generate())
    Process.sleep(2)

    Authority.store(
      episode,
      %{status: "active", participants: %{{String.downcase(person), 1} => "active"}},
      System.monotonic_time(:millisecond),
      nil
    )

    {:ok, ^owner, _, [%{"participant_id" => ^person}]} = ViewOwner.join(episode, UUID.generate())
  end

  defp publish_then_disconnect(episode, person, stream, test) do
    {socket, ref} =
      spawn_monitor(fn ->
        {:ok, owner, _, _} = ViewOwner.join(episode, person)
        :ok = ViewOwner.move(owner, frame(person, 10), input(stream, 1))
        send(test, :published)
        receive do: (:disconnect -> :ok)
      end)

    assert_receive :published
    send(socket, :disconnect)
    assert_receive {:DOWN, ^ref, :process, ^socket, :normal}
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
