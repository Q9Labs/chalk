defmodule ChalkSync.WhiteboardV1.ViewOwnerCapacityTest do
  use ChalkSync.WhiteboardV1.ViewOwnerCase, async: true

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority.Reads
  alias ChalkSync.WhiteboardV1.ViewOwner

  test "admits all 500 canonical Episode participants", c do
    assert GeneratedWhiteboardV1.limits()["viewPeopleMaxItems"] ==
             Reducer.max_participants()

    for _ <- 2..500 do
      assert {:ok, owner, _, []} = ViewOwner.join(c.episode, UUID.generate())
      assert owner == c.owner
    end

    assert {:error, :overloaded} = ViewOwner.join(c.episode, UUID.generate())
  end

  test "a join at capacity retires a dead socket before its queued DOWN", c do
    for _ <- 2..(Reducer.max_participants() - 1) do
      assert {:ok, owner, _, []} = ViewOwner.join(c.episode, UUID.generate())
      assert owner == c.owner
    end

    test = self()

    {socket, ref} =
      spawn_monitor(fn ->
        {:ok, _, _, []} = ViewOwner.join(c.episode, UUID.generate())
        send(test, :joined)
        receive do: (:leave -> :ok)
      end)

    on_exit(fn -> if Process.alive?(socket), do: Process.exit(socket, :kill) end)
    assert_receive :joined
    assert {:error, :overloaded} = ViewOwner.join(c.episode, UUID.generate())

    :ok = :sys.suspend(c.owner)

    request =
      try do
        # Queue the join first, then prove the socket is dead before handling either message.
        request = :gen_server.send_request(c.owner, {:join, self(), UUID.generate()})
        Process.exit(socket, :kill)
        assert_receive {:DOWN, ^ref, :process, ^socket, :killed}
        request
      after
        :ok = :sys.resume(c.owner)
      end

    owner = c.owner
    assert {:reply, {:ok, ^owner, _, []}} = :gen_server.receive_response(request, 1_000)
    state = :sys.get_state(owner)
    assert MapSet.size(state.people) == Reducer.max_participants()
    refute Enum.any?(state.sockets, fn {_ref, {pid, _person}} -> pid == socket end)
    assert {:error, :overloaded} = ViewOwner.join(c.episode, UUID.generate())
  end

  test "retired people free admission without forgetting uncertain retry receipts", c do
    test = self()
    person = UUID.generate()
    stream = UUID.generate()

    :ok =
      :sys.install(
        c.owner,
        {fn
           state, {:in, {:DOWN, _, :process, socket, :normal}}, _ ->
             send(test, {:retiring, socket})
             state

           state, _, _ ->
             state
         end, nil}
      )

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
      # Our monitor and the owner's monitor deliver independent DOWN messages.
      # The state call follows the owner's handler only after it sees its DOWN.
      assert_receive {:retiring, ^socket}, 1_000
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

    Reads.store(
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

      Reads.store(
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

    Reads.store(
      episode,
      %{status: "active", participants: %{}},
      System.monotonic_time(:millisecond) - 10,
      nil
    )

    {:ok, owner, _, []} = ViewOwner.join(episode, person)
    :ok = ViewOwner.move(owner, frame(person, 10), input(UUID.generate(), 1))
    {:ok, ^owner, _, [%{"participant_id" => ^person}]} = ViewOwner.join(episode, UUID.generate())
    Process.sleep(2)

    Reads.store(
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
end
