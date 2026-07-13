defmodule ChalkSync.Stateholder.PostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres

  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    fixture = SyncPostgres.seed_session(hd(connections))
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    {:ok, fixture: fixture}
  end

  test "commits event, fold, revision, and receipt atomically", %{fixture: fixture} do
    identity = hd(fixture.identities)
    command = command("atomic_command_01", :raise_hand)

    assert {:ok, committed} = Postgres.decide_command(identity, command)
    assert committed.result == :committed
    assert committed.revision == 2
    assert is_binary(committed.event_id)

    assert {:ok, duplicate} = Postgres.resolve_receipt(identity, command)
    assert duplicate.result == :duplicate
    assert duplicate.event_id == committed.event_id
    assert duplicate.revision == committed.revision

    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)
    assert recovery.head.revision == 2
    assert hd(recovery.snapshot["participants"])["hand_raised"]

    assert {:ok, identity_recovery} = Postgres.recover(identity, nil)
    assert identity_recovery.head == recovery.head

    assert_independent_fold(identity, fixture.state)
  end

  test "plans replay without retaining its suffix and fetches fixed-head pages", %{
    fixture: fixture
  } do
    identity = hd(fixture.identities)
    assert {:ok, initial} = Postgres.recover(identity, nil)

    Enum.each(1..129, fn index ->
      name = if rem(index, 2) == 1, do: :raise_hand, else: :lower_hand

      assert {:ok, %{result: :committed, revision: revision}} =
               Postgres.decide_command(
                 identity,
                 command("pg_page_#{String.pad_leading(to_string(index), 8, "0")}", name)
               )

      assert revision == index + 1
    end)

    assert {:ok, recovery} = Postgres.recover(identity, initial.head)
    assert recovery.mode == :replay
    assert recovery.head.revision == 130
    assert recovery.replay_cursor == 1
    assert recovery.events == []

    assert {:ok, first_page} = Postgres.recovery_page(identity.session, 1, 130)
    assert length(first_page) == 128
    assert {hd(first_page).revision, List.last(first_page).revision} == {2, 129}

    assert {:ok, second_page} = Postgres.recovery_page(identity.session, 129, 130)
    assert Enum.map(second_page, & &1.revision) == [130]
  end

  test "returns authoritative terminal recovery for ended or stale participant identity", %{
    fixture: fixture
  } do
    identity = hd(fixture.identities)
    connection = ChalkSync.Database.connection(identity.session)
    stale_identity = %{identity | participant_session_generation: 2}

    assert {:ok, stale} = Postgres.recover(stale_identity, nil)
    assert stale.mode == :terminal
    assert stale.terminal_reason == :stale_participant_generation
    assert stale.snapshot == nil

    Postgrex.query!(
      connection,
      "update room_sessions set status = 'ending' where tenant_id = $1 and id = $2",
      [UUID.dump!(identity.session.tenant_id), UUID.dump!(identity.session.session_id)]
    )

    assert {:ok, ended} = Postgres.recover(identity, nil)
    assert ended.mode == :terminal
    assert ended.terminal_reason == :session_ended
    assert ended.head.revision == fixture.state.revision
  end

  test "retains receipts beyond the former 256-command cache and across node connections", %{
    fixture: fixture,
    connections: connections
  } do
    identity = hd(fixture.identities)
    original = command("durable_original1", :raise_hand)

    assert {:ok, %{result: :committed, revision: 2} = first} =
             Postgres.decide_command(identity, original)

    Enum.each(1..300, fn index ->
      filler = command("filler_#{String.pad_leading(to_string(index), 9, "0")}", :raise_hand)

      assert {:ok, %{result: :rejected, reason: :invalid_state}} =
               Postgres.decide_command(identity, filler)
    end)

    alternate = SyncPostgres.start_connections(@database_url)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(alternate))

    try do
      assert {:ok, duplicate} = Postgres.decide_command(identity, original)
      assert duplicate.result == :duplicate
      assert duplicate.event_id == first.event_id
      assert duplicate.revision == first.revision
    after
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
      Enum.each(alternate, &stop_connection/1)
    end
  end

  test "resolves an unknown commit outcome from its durable receipt", %{fixture: fixture} do
    identity = hd(fixture.identities)
    command = command("ambiguous_commit1", :raise_hand)

    Application.put_env(:chalk_sync, :stateholder_fault_hook, fn point, _context ->
      if point == :after_commit_before_reply, do: raise("lost commit response")
    end)

    try do
      assert {:ok, decision} = Postgres.decide_command(identity, command)
      assert decision.result == :duplicate
      assert decision.revision == 2
    after
      Application.delete_env(:chalk_sync, :stateholder_fault_hook)
    end

    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)
    assert recovery.head.revision == 2
  end

  test "rolls back a crash before commit and safely retries the same command", %{fixture: fixture} do
    identity = hd(fixture.identities)
    command = command("rollback_retry_01", :raise_hand)

    Application.put_env(:chalk_sync, :stateholder_fault_hook, fn point, _context ->
      if point == :after_event_insert, do: raise("crash before commit")
    end)

    try do
      assert Postgres.decide_command(identity, command) ==
               {:retryable, :decision_unavailable}
    after
      Application.delete_env(:chalk_sync, :stateholder_fault_hook)
    end

    assert Postgres.resolve_receipt(identity, command) == :not_found
    assert {:ok, %{result: :committed, revision: 2}} = Postgres.decide_command(identity, command)
  end

  test "serializes concurrent decisions from independent node connection sets", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_session(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    [first_identity, second_identity] = fixture.identities

    first =
      Task.async(fn ->
        Process.put(:sync_test_node, :first)
        Postgres.decide_command(first_identity, command("node_first_cmd01", :raise_hand))
      end)

    second =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)
        Postgres.decide_command(second_identity, command("node_second_cmd1", :raise_hand))
      end)

    decisions = [Task.await(first), Task.await(second)]
    assert Enum.all?(decisions, &match?({:ok, %{result: :committed}}, &1))

    assert decisions |> Enum.map(fn {:ok, decision} -> decision.revision end) |> Enum.sort() == [
             3,
             4
           ]

    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)
    assert recovery.head.revision == 4
    assert Enum.all?(recovery.snapshot["participants"], & &1["hand_raised"])
  end

  test "derives conflicts and preserves stable terminal rejections", %{fixture: fixture} do
    identity = hd(fixture.identities)
    original = command("stable_outcome_01", :raise_hand)
    changed = command("stable_outcome_01", :lower_hand)

    assert {:ok, %{result: :committed}} = Postgres.decide_command(identity, original)

    assert {:ok, %{result: :command_id_conflict}} =
             Postgres.decide_command(identity, changed)

    rejected = command("stable_reject_001", :raise_hand)

    assert {:ok, %{result: :rejected, reason: :invalid_state}} =
             Postgres.decide_command(identity, rejected)

    assert {:ok, %{result: :committed}} =
             Postgres.decide_command(identity, command("lower_after_rej1", :lower_hand))

    assert {:ok, %{result: :rejected, reason: :invalid_state}} =
             Postgres.decide_command(identity, rejected)
  end

  test "does not leak a receipt through a mismatched Room authority key", %{fixture: fixture} do
    %Identity{} = identity = hd(fixture.identities)
    %SessionKey{} = session = identity.session
    command = command("room_context_cmd1", :raise_hand)
    assert {:ok, %{result: :committed}} = Postgres.decide_command(identity, command)

    wrong_room = %Identity{
      identity
      | session: %SessionKey{session | room_id: UUID.generate()}
    }

    assert Postgres.resolve_receipt(wrong_room, command) == :not_found
    assert {:retryable, _reason} = Postgres.decide_command(wrong_room, command)
  end

  test "persists participant-inactive rejection when the participant row is absent", %{
    fixture: fixture
  } do
    %Identity{} = identity = hd(fixture.identities)

    missing = %Identity{
      identity
      | participant_session_id: UUID.generate(),
        admission_lifecycle_intent_id: UUID.generate()
    }

    command = command("missing_part_cmd01", :raise_hand)

    assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
             Postgres.decide_command(missing, command)

    assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
             Postgres.decide_command(missing, command)
  end

  test "satisfies an unchanged v3 target without an Event or head change", %{fixture: fixture} do
    identity = hd(fixture.identities)
    target = command_payload("satisfied_target1", :set_hand_raised, %{"raised" => false})

    assert {:ok, before_recovery} = Postgres.recover(fixture.session, nil)

    assert {:ok, satisfied} = Postgres.decide_command(identity, target)
    assert satisfied.result == :satisfied
    assert satisfied.delivery == :original
    assert satisfied.revision == before_recovery.head.revision
    assert satisfied.state_digest == before_recovery.head.digest

    assert {:ok, duplicate} = Postgres.decide_command(identity, target)
    assert duplicate.result == :satisfied
    assert duplicate.delivery == :duplicate
    assert duplicate.revision == satisfied.revision
    assert duplicate.state_digest == satisfied.state_digest

    assert {:ok, after_recovery} = Postgres.recover(fixture.session, nil)
    assert after_recovery.head == before_recovery.head
  end

  test "authorizes from locked current role and transfers host atomically", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_session(hd(connections), 2)
    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    [host, participant] = fixture.identities

    assert {:ok, %{result: :rejected, reason: :capability_denied}} =
             Postgres.decide_command(
               %{participant | capabilities: ["manageAdmission", "transferHost"]},
               command_payload("untrusted_claims1", :set_admission_policy, %{
                 "policy" => "approval"
               })
             )

    assert {:ok, %{result: :committed, event: event}} =
             Postgres.decide_command(
               host,
               command_payload("atomic_transfer1", :transfer_host, %{
                 "participantSessionId" => participant.participant_session_id
               })
             )

    assert event.name == "host_transferred"
    assert {:ok, recovery} = Postgres.recover(fixture.session, nil)
    assert recovery.snapshot["host_participant_session_id"] == participant.participant_session_id

    roles =
      Map.new(recovery.snapshot["participants"], &{&1["participant_session_id"], &1["role"]})

    assert roles[host.participant_session_id] == "cohost"
    assert roles[participant.participant_session_id] == "host"
  end

  defp assert_independent_fold(identity, initial_state) do
    connection = ChalkSync.Database.connection(identity.session)

    rows =
      Postgrex.query!(
        connection,
        """
        select event_name, base_revision, revision, payload
        from sync_control_events
        where tenant_id = $1 and session_id = $2 and revision > $3
        order by revision
        """,
        [
          UUID.dump!(identity.session.tenant_id),
          UUID.dump!(identity.session.session_id),
          initial_state.revision
        ]
      ).rows

    folded =
      Enum.reduce(rows, initial_state, fn [name, base, revision, payload], state ->
        {:ok, state} =
          Reducer.apply_event(state, %{
            name: name,
            base_revision: base,
            revision: revision,
            payload: payload
          })

        state
      end)

    assert {:ok, recovery} = Postgres.recover(identity.session, nil)
    assert Reducer.snapshot(folded) == recovery.snapshot
  end

  defp command(id, name) do
    {:ok, command} = Command.new(String.pad_trailing(id, 16, "_"), name, %{})
    command
  end

  defp command_payload(id, name, payload) do
    {:ok, command} = Command.new(String.pad_trailing(id, 16, "_"), name, payload)
    command
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
