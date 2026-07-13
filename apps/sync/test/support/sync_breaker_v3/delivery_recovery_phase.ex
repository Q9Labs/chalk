defmodule ChalkSync.SyncBreakerV3.DeliveryRecoveryPhase do
  @moduledoc false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Sessions.Coordinator
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncBreakerV3.DeliveryGateAdapter, as: Gate
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.Transport.Router

  @bounds %{"actions" => 16, "held_emissions" => 64, "observations" => 256}

  def run!(database_url, seed \\ 730_014) do
    connections = SyncPostgres.start_connections(database_url, 6)
    previous = install(connections)
    {:ok, media_plane} = MediaPlaneTestAdapter.start_link()
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, media_plane})
    {:ok, listener} = Bandit.start_link(plug: Router, ip: {127, 0, 0, 1}, port: 0)
    {:ok, {_ip, port}} = ThousandIsland.listener_info(listener)

    try do
      results = [
        ack_before_event(port, connections),
        event_before_ack(port, connections),
        dropped_hint_repair(port, connections),
        disconnect_recovery(port, connections),
        coordinator_restart(port, connections),
        live_frame_release(port, connections),
        duplicate_delivery(port, connections)
      ]

      %{
        "name" => "delivery_recovery",
        "seed" => seed,
        "schedule" => Enum.map(results, & &1["name"]),
        "observations" => Enum.flat_map(results, & &1["observations"]),
        "evidence" => Map.new(results, &{&1["name"], &1["evidence"]}),
        "bounds" => @bounds,
        "invariants" => [
          "held emissions do not enter the socket mailbox before release",
          "authoritative PostgreSQL recovery repairs dropped hints and coordinator loss",
          "duplicate delivery does not duplicate a control event on the wire"
        ],
        "verdict" => "pass"
      }
    after
      Gate.stop()
      GenServer.stop(listener)
      restore(previous)
      Enum.each(connections, &stop/1)
    end
  end

  defp ack_before_event(port, connections) do
    with_fixture(connections, fn fixture ->
      start_gate([])
      client = connect_live(port, hd(fixture.identities))
      start_gate([{:control_ready, %{phase: :live}, {:hold, :event}}])
      client = Client.send_json(client, command("breaker_ack_first_01", true))
      assert_observed(:control_ready, {:hold, :event})

      {:json, %{"type" => "ack", "command_id" => "breaker_ack_first_01"}, client} =
        Client.recv(client)

      assert_no_frame(client)
      {:ok, 1} = Gate.release(:event)

      {:json, %{"type" => "event", "command_id" => "breaker_ack_first_01"}, _client} =
        Client.recv(client)

      result("ack_before_event", %{"first" => "ack", "second" => "event"})
    end)
  end

  defp event_before_ack(port, connections) do
    with_fixture(connections, fn fixture ->
      start_gate([])
      client = connect_live(port, hd(fixture.identities))
      start_gate([{:command_result, {:hold, :ack}}])
      client = Client.send_json(client, command("breaker_event_first01", true))
      assert_observed(:command_result, {:hold, :ack})
      send(Coordinator.whereis(fixture.session), :repair_now)

      {:json, %{"type" => "event", "command_id" => "breaker_event_first01"}, client} =
        Client.recv(client)

      assert_no_frame(client)
      {:ok, 1} = Gate.release(:ack)

      {:json, %{"type" => "ack", "command_id" => "breaker_event_first01"}, _client} =
        Client.recv(client)

      result("event_before_ack", %{"first" => "event", "second" => "ack"})
    end)
  end

  defp dropped_hint_repair(port, connections) do
    with_fixture(connections, fn fixture ->
      start_gate([])
      identity = hd(fixture.identities)
      client = connect_live(port, identity)

      start_gate([
        {:postgres_head_hint, :drop},
        {:command_result, {:hold, :dropped_hint_ack}}
      ])

      client = Client.send_json(client, command("breaker_dropped_hint1", true))
      assert_observed(:postgres_head_hint, :drop)
      assert_observed(:command_result, {:hold, :dropped_hint_ack})
      assert_no_frame(client)
      coordinator = Coordinator.whereis(fixture.session)
      send(coordinator, :repair_now)
      {:json, %{"type" => "event", "revision" => revision}, client} = Client.recv(client)
      {:ok, 1} = Gate.release(:dropped_hint_ack)
      {:json, %{"type" => "ack", "revision" => ^revision}, _client} = Client.recv(client)
      result("dropped_hint_repair", %{"repair" => "authoritative", "converged" => true})
    end)
  end

  defp disconnect_recovery(port, connections) do
    with_fixture(connections, fn fixture ->
      start_gate([])
      identity = hd(fixture.identities)
      {:ok, client} = Client.connect(port, "/v3/sync")
      client = Client.send_json(client, hello(identity))
      {:json, %{"type" => "welcome"}, client} = Client.recv(client)
      _closed = Client.close_tcp(client)
      reconnected = connect_live(port, identity)
      result("disconnect_before_recovery_ack", %{"reconnected" => match?(%Client{}, reconnected)})
    end)
  end

  defp coordinator_restart(port, connections) do
    with_fixture(connections, fn fixture ->
      start_gate([])
      identity = hd(fixture.identities)
      client = connect_live(port, identity)
      coordinator = Coordinator.whereis(fixture.session)
      monitor = Process.monitor(coordinator)
      _closed = Client.close_tcp(client)
      Process.exit(coordinator, :kill)
      receive do: ({:DOWN, ^monitor, :process, ^coordinator, _reason} -> :ok)
      reconnected = connect_live(port, identity)
      {:ok, recovery} = Postgres.recover(fixture.session, nil)

      result("coordinator_kill_restart", %{
        "reconnected" => match?(%Client{}, reconnected),
        "postgres_revision" => recovery.head.revision
      })
    end)
  end

  defp live_frame_release(port, connections) do
    with_fixture(connections, fn fixture ->
      start_gate([])
      observer = hd(fixture.identities)
      observer_client = connect_live(port, observer)

      {_adapter_module, adapter} = Application.fetch_env!(:chalk_sync, :media_plane)

      start_gate([
        {:live_frame, {:hold, :earlier_live}},
        {:live_frame, {:hold, :later_live}}
      ])

      earlier = [publication(observer, :camera)]
      MediaPlaneTestAdapter.put_outcome(adapter, :observe_session_publications, {:ok, earlier})
      :ok = Coordinator.reconcile_live(Coordinator.whereis(fixture.session))
      assert_observed(:live_frame, {:hold, :earlier_live})
      assert_no_frame(observer_client)

      later = earlier ++ [publication(observer, :microphone)]
      MediaPlaneTestAdapter.put_outcome(adapter, :observe_session_publications, {:ok, later})
      :ok = Coordinator.reconcile_live(Coordinator.whereis(fixture.session))
      assert_observed(:live_frame, {:hold, :later_live})
      assert_no_frame(observer_client)

      {:ok, 1} = Gate.release(:later_live)

      {:json,
       %{"stream" => "media", "type" => "projection_event", "item" => later_item} =
         later_frame, observer_client} =
        Client.recv(observer_client)

      {:ok, 1} = Gate.release(:earlier_live)

      {:json,
       %{"stream" => "media", "type" => "projection_event", "item" => earlier_item} =
         earlier_frame, _client} =
        Client.recv(observer_client)

      "microphone" = later_item["source"]
      "camera" = earlier_item["source"]

      result("held_released_live_frame", %{
        "wire_sources" => [later_item["source"], earlier_item["source"]],
        "wire_sequences" => [later_frame["sequence"], earlier_frame["sequence"]],
        "release_order" => ["later", "earlier"]
      })
    end)
  end

  defp duplicate_delivery(port, connections) do
    with_fixture(connections, fn fixture ->
      start_gate([])
      client = connect_live(port, hd(fixture.identities))
      start_gate([{:control_ready, %{phase: :live}, :duplicate}])
      client = Client.send_json(client, command("breaker_duplicate_01", true))
      assert_observed(:control_ready, :duplicate)
      {types, client} = receive_command_pair(client, [])
      assert_no_frame(client)
      true = Enum.sort(types) == ["ack", "event"]

      result("duplicate_delivery_tolerance", %{
        "wire_event_count" => Enum.count(types, &(&1 == "event"))
      })
    end)
  end

  defp receive_command_pair(client, types) when length(types) == 2, do: {types, client}

  defp receive_command_pair(client, types) do
    {:json, %{"type" => type}, client} = Client.recv(client)
    receive_command_pair(client, [type | types])
  end

  defp connect_live(port, identity) do
    {:ok, client} = Client.connect(port, "/v3/sync")
    client = Client.send_json(client, hello(identity))
    {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    {:json, %{"type" => "projection_snapshot", "stream" => "media"}, client} = Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "presence"}, client} =
      Client.recv(client)

    client
  end

  defp hello(identity) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.session.tenant_id,
        "room_id" => identity.session.room_id,
        "session_id" => identity.session.session_id,
        "participant_id" => identity.participant_session_id,
        "participant_session_id" => identity.participant_session_id,
        "participant_session_generation" => identity.participant_session_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "initial_role" => identity.role,
        "eligible_roles" => identity.eligible_roles,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 3,
      "token" => token,
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }
  end

  defp command(id, raised),
    do: %{
      "type" => "command",
      "command_id" => id,
      "name" => "set_hand_raised",
      "payload" => %{"raised" => raised}
    }

  defp publication(identity, source) do
    %{
      participant_session_id: identity.participant_session_id,
      source: source,
      enabled: true,
      publication_id: "breaker-#{source}-publication"
    }
  end

  defp assert_no_frame(client) do
    {:error, :timeout, _client} = Client.recv_now(client)
    :ok
  end

  defp assert_observed(checkpoint, action) do
    {:ok, %{checkpoint: ^checkpoint, action: ^action}} = Gate.await_action(checkpoint, action)
  end

  defp result(name, evidence) do
    %{"name" => name, "evidence" => evidence, "observations" => normalized_observations()}
  end

  defp normalized_observations do
    Enum.map(Gate.observations(), fn observation ->
      %{
        "checkpoint" => Atom.to_string(observation.checkpoint),
        "action" => normalize_action(observation.action)
      }
    end)
  end

  defp normalize_action({:hold, tag}), do: "hold:#{tag}"
  defp normalize_action(action), do: Atom.to_string(action)

  defp with_fixture(connections, fun) do
    fixture = SyncPostgres.seed_session(hd(connections), 2)

    try do: fun.(fixture),
        after:
          (
            Gate.stop()
            SyncPostgres.cleanup(hd(connections), fixture.session)
          )
  end

  defp start_gate(actions) do
    Gate.stop()
    {:ok, _pid} = Gate.start_link(actions)
  end

  defp install(connections) do
    keys = [:stateholder, :database_connections, :delivery_gate_adapter, :media_plane]
    previous = Map.new(keys, &{&1, Application.get_env(:chalk_sync, &1)})
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    Application.put_env(:chalk_sync, :delivery_gate_adapter, Gate)
    previous
  end

  defp restore(previous),
    do:
      Enum.each(previous, fn
        {key, nil} -> Application.delete_env(:chalk_sync, key)
        {key, value} -> Application.put_env(:chalk_sync, key, value)
      end)

  defp stop(pid), do: if(Process.alive?(pid), do: GenServer.stop(pid))
end
