defmodule ChalkSync.EntryInterleavingsPostgresTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Chat.Repository.Postgres, as: ChatPostgres
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")
  @seed {358, 20_261_024, 12}
  @captures JSON.decode!(
              File.read!(Path.expand("../fixtures/published-entry-hellos.json", __DIR__))
            )

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
    connections = SyncPostgres.start_connections(@database_url)
    Enum.each(connections, &Process.unlink/1)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    connection = hd(connections)

    # Fail at real PostgreSQL COMMIT, after the confirmation transaction's body
    # succeeded. The historical join intent is already applied in every case.
    Postgrex.query!(
      connection,
      """
      create function chalk_test_entry_commit_failure() returns trigger language plpgsql as $$
      begin
        if current_setting('chalk.test_confirmation_commit', true) = 'rollback'
           and new.confirmed_entry_generation > old.confirmed_entry_generation then
          raise exception 'injected confirmation commit failure';
        end if;
        return new;
      end $$
      """,
      []
    )

    Postgrex.query!(
      connection,
      """
      create constraint trigger chalk_test_entry_commit_failure
      after update on participant_join_seats deferrable initially deferred
      for each row execute function chalk_test_entry_commit_failure()
      """,
      []
    )

    on_exit(fn ->
      Postgrex.query!(
        connection,
        "drop trigger chalk_test_entry_commit_failure on participant_join_seats",
        []
      )

      Postgrex.query!(connection, "drop function chalk_test_entry_commit_failure()", [])
      Application.put_env(:chalk_sync, :stateholder, stateholder)
      restore_env(:database_connections, previous)
      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: connection, connections: connections}
  end

  @tag timeout: 180_000
  test "bounded entry interleavings preserve ownership and eventual departure", context do
    :rand.seed(:exsss, @seed)

    scenarios =
      for initial <- [:modern, "5.0.0", "5.1.0"],
          confirmation <- [:normal, :reply_lost, :commit_not_applied],
          {name, entry, old} <- [
            {:entry, [:admit, :recover, :confirm], [:accept_old, :finalize_old]},
            {:refresh, [:admit, :refresh, :recover, :confirm], [:accept_old, :finalize_old]},
            {:retry, [:admit, :recover, :confirm], [:confirm_old, :accept_old, :finalize_old]}
          ],
          steps <- interleave(entry, old),
          before?(steps, :admit, :finalize_old),
          do: %{name: name, initial: initial, confirmation: confirmation, steps: steps}

    legacy_scenarios =
      for version <- ["5.0.0", "5.1.0"],
          frame <- ["reconnect_hello", "retry_hello"],
          steps <- interleave([:published_hello], [:accept_old, :finalize_old]),
          before?(steps, :published_hello, :finalize_old),
          do: %{
            name: :legacy_reentry,
            initial: version,
            frame: frame,
            confirmation: :normal,
            steps: steps
          }

    scenarios = scenarios ++ legacy_scenarios
    failures = scenarios |> Enum.shuffle() |> Enum.flat_map(&run_scenario(&1, context))
    sdk_steps = interleave([:upgrade, :reconnect], [:refresh, :accept_old, :finalize_old])
    sdk_steps = Enum.filter(sdk_steps, &before?(&1, :reconnect, :finalize_old))
    bridge = start_bridge()

    sdk_failures =
      try do
        Enum.flat_map(sdk_steps, fn steps ->
          run_scenario(
            %{name: :sync_upgrade, initial: :sdk, confirmation: :normal, steps: steps},
            Map.put(context, :bridge, bridge)
          )
        end)
      after
        Port.close(bridge)
      end

    all_failures = failures ++ sdk_failures

    IO.puts(
      "ENTRY_ORDERINGS seed=#{inspect(@seed)} postgres=#{length(scenarios)} sdk_upgrade=#{length(sdk_steps)} executed=#{length(scenarios) + length(sdk_steps)} failures=#{length(all_failures)}"
    )

    if path = System.get_env("CHALK_ENTRY_INTERLEAVING_REPORT") do
      File.write!(
        path,
        JSON.encode!(%{
          seed: Tuple.to_list(@seed),
          postgres: length(scenarios),
          sdk_upgrade: length(sdk_steps),
          failures:
            Enum.map(all_failures, &%{scenario: inspect(&1.scenario), violation: &1.violation})
        })
      )
    end

    assert all_failures == [], Enum.map_join(Enum.take(all_failures, 12), "\n", &inspect/1)
  end

  defp run_scenario(scenario, context) do
    fixture = SyncPostgres.seed_pending_join(context.connection)

    try do
      older = initial_entry(scenario.initial, fixture.identity, context)
      {:ok, operation} = Operation.new("interleaving_old_leave_0001", :participant_leave, %{})

      state = %{
        older: older,
        current: nil,
        operation: operation,
        operation_id: nil,
        confirmed: older.entry_generation,
        step: nil
      }

      state =
        Enum.reduce(scenario.steps, state, fn step, state ->
          before = row(context.connection, fixture.identity)
          state = execute(step, state, scenario, context)
          check_invariants(state, before, scenario, context)
          state
        end)

      drain(state, context)
      []
    rescue
      error in ExUnit.AssertionError ->
        [%{scenario: scenario, violation: Exception.message(error)}]
    after
      if scenario.initial == :sdk, do: rpc(context.bridge, %{step: :close})
      SyncPostgres.cleanup(context.connection, fixture.episode)
    end
  end

  defp execute(:admit, state, _scenario, _context) do
    assert {:ok, current} = Postgres.admit_entry(state.older, :new)
    assert current.entry_generation > state.older.entry_generation
    %{state | current: current, step: :admit}
  end

  defp execute(:published_hello, state, scenario, context) do
    current = published_entry(scenario.initial, scenario.frame, state.older, context)
    assert current.entry_generation > state.older.entry_generation
    %{state | current: current, confirmed: current.entry_generation, step: :published_hello}
  end

  defp execute(:recover, state, _scenario, _context) do
    assert {:ok, recovery} = Postgres.recover(state.current, nil)

    assert recovery.mode != :terminal,
           "admitted replacement recovered terminal: #{inspect(recovery)}"

    %{state | step: :recover}
  end

  defp execute(:confirm, state, scenario, context) do
    result = confirm_entry(state.current, scenario.confirmation, context.connections)
    actual = row(context.connection, state.older)

    if match?({:ok, _}, result),
      do:
        assert(
          actual.confirmed >= state.current.entry_generation,
          "confirmation acknowledged an uncommitted entry generation"
        )

    assert {:ok, _} = Postgres.confirm_admission(state.current)
    %{state | confirmed: max(state.confirmed, state.current.entry_generation), step: :confirm}
  end

  defp execute(:confirm_old, state, _scenario, _context) do
    assert {:ok, _} = Postgres.confirm_admission(state.older)
    %{state | step: :confirm_old}
  end

  defp execute(:accept_old, state, _scenario, _context) do
    case Postgres.begin_operation(state.older, state.operation) do
      {:ok, %{result: :pending, external_operation_id: id}} ->
        %{state | operation_id: id, step: :accept_old}

      {:ok, %{result: :rejected}} ->
        %{state | step: :accept_old}
    end
  end

  defp execute(:finalize_old, state, _scenario, _context) do
    finalize_old(state)
    %{state | step: :finalize_old}
  end

  defp execute(:refresh, state, %{initial: :sdk}, context) do
    rpc(context.bridge, %{step: :refresh, token: token(state.older, 2)})
    %{state | step: :refresh}
  end

  defp execute(:refresh, state, _scenario, _context) do
    assert {:ok, claims} = DevTokenVerifier.verify(token(state.current, 2))

    refreshed = %Identity{
      episode: state.current.episode,
      participant_id: claims.participant_id,
      participant_generation: claims.participant_generation,
      admission_lifecycle_intent_id: claims.admission_lifecycle_intent_id,
      role: claims.role,
      capabilities: claims.capabilities,
      entry_generation: state.current.entry_generation
    }

    assert {:ok, resumed} = Postgres.admit_entry(refreshed, refreshed.entry_generation)
    assert resumed.entry_generation == state.current.entry_generation
    %{state | current: resumed, step: :refresh}
  end

  defp execute(:upgrade, state, _scenario, context) do
    rpc(context.bridge, %{step: :upgrade})
    %{state | step: :upgrade}
  end

  defp execute(:reconnect, state, _scenario, context) do
    result = rpc(context.bridge, %{step: :reconnect})
    actual = row(context.connection, state.older)
    assert result["phase"] == "live", "admitted upgrade connection became terminal"
    assert result["entered"] == 1, "completed startup did not confirm after Sync upgrade"
    assert result["acknowledged"] == 1
    assert result["generation"] == actual.confirmed

    %{
      state
      | current: %{state.older | entry_generation: actual.confirmed},
        confirmed: actual.confirmed,
        step: :reconnect
    }
  end

  defp check_invariants(state, before, _scenario, context) do
    actual = row(context.connection, state.older)
    assert actual.confirmed >= before.confirmed, "confirmation moved backward"
    assert actual.confirmed >= state.confirmed, "confirmed ownership disappeared"
    assert actual.status != "left", "an older Leave removed the admitted/current entry"
    assert actual.seat == "joined"

    if actual.status == "leaving" do
      assert actual.pending > 0, "participant is stuck leaving without pending work"
    end

    if state.current do
      assert {:ok, recovery} = Postgres.recover(state.current, nil)

      assert recovery.mode != :terminal,
             "admitted current entry turned terminal after #{state.step}"

      if actual.status == "leaving" do
        assert {:ok, _} = ChatPostgres.participant_capabilities(state.current)
        assert {:error, :participant_stale} = ChatPostgres.participant_capabilities(state.older)
      end
    end

    # Acceptance probe is rolled back, so checking leaveability cannot alter the
    # next ordering. A retry of an already accepted Leave must remain accepted.
    current =
      if actual.confirmed == state.older.entry_generation, do: state.older, else: state.current

    probe_leave(context.connection, current, state, actual)
  end

  defp probe_leave(connection, current, state, actual, retries \\ 2) do
    selector = Application.fetch_env!(:chalk_sync, :database_connections)

    result =
      try do
        Postgrex.transaction(connection, fn transaction ->
          Application.put_env(:chalk_sync, :database_connections, fn _episode, _offset ->
            transaction
          end)

          {:ok, fresh} =
            Operation.new("interleaving_probe_leave_0001", :participant_leave, %{})

          operation = if actual.status == "leaving", do: state.operation, else: fresh

          case Postgres.begin_operation(current, operation) do
            {:retryable, _reason} -> Postgrex.rollback(transaction, :probe_retry)
            decision -> assert {:ok, %{result: :pending}} = decision
          end

          Postgrex.rollback(transaction, :probe_complete)
        end)
      after
        Application.put_env(:chalk_sync, :database_connections, selector)
      end

    case result do
      {:error, :probe_complete} ->
        :ok

      {:error, :probe_retry} when retries > 0 ->
        # A deliberately aborted COMMIT can disconnect Postgrex. Re-check the
        # recovered connection before retrying; never retry a permanent rejection.
        Postgrex.query!(connection, "select 1", [])
        probe_leave(connection, current, state, actual, retries - 1)

      other ->
        flunk("current entry cannot Leave: #{inspect(other)}")
    end
  end

  defp drain(state, context) do
    finalize_old(state)
    actual = row(context.connection, state.older)
    assert actual.status != "leaving", "pending Leave did not settle"
    current = state.current || state.older
    id = current_leave(current, context)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(current.episode, id, {:confirmed, :provider})

    assert %{status: "left", seat: "left"} = row(context.connection, current)
  end

  defp current_leave(current, %{bridge: bridge} = context) do
    result = rpc(bridge, %{step: :leave})
    assert result["operationReply"] == "retryable_error"

    assert [[id, generation]] =
             Postgrex.query!(
               context.connection,
               """
               select operation.external_operation_id,operation.payload->>'entryGeneration'
               from sync_external_operations operation join sync_command_receipts receipt using(external_operation_id)
               where receipt.tenant_id=$1 and receipt.command_id=$2
               """,
               [UUID.dump!(current.episode.tenant_id), result["operation"]]
             ).rows

    assert generation == Integer.to_string(current.entry_generation)
    UUID.load!(id)
  end

  defp current_leave(current, _context) do
    {:ok, operation} = Operation.new("interleaving_current_leave_0001", :participant_leave, %{})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(current, operation)

    id
  end

  defp finalize_old(%{operation_id: nil}), do: :ok

  defp finalize_old(state) do
    case Postgres.prepare_entry_leave(state.older.episode, state.operation_id) do
      :pending ->
        :ok

      _ ->
        Postgres.finalize_operation(
          state.older.episode,
          state.operation_id,
          {:confirmed, :provider}
        )
    end
  end

  defp confirm_entry(identity, confirmation, connections) do
    previous = Application.get_env(:chalk_sync, :lifecycle_fault_hook)

    try do
      if confirmation == :reply_lost,
        do:
          Application.put_env(:chalk_sync, :lifecycle_fault_hook, fn
            :after_commit_before_reply, _ -> raise "injected lost confirmation reply"
            _, _ -> :ok
          end)

      if confirmation == :commit_not_applied,
        do:
          Enum.each(
            connections,
            &Postgrex.query!(
              &1,
              "select set_config('chalk.test_confirmation_commit','rollback',false)",
              []
            )
          )

      Postgres.confirm_admission(identity)
    after
      restore_env(:lifecycle_fault_hook, previous)

      if confirmation == :commit_not_applied,
        do:
          Enum.each(
            connections,
            &Postgrex.query!(
              &1,
              "select set_config('chalk.test_confirmation_commit','',false)",
              []
            )
          )
    end
  end

  defp initial_entry(:modern, identity, _context) do
    assert {:ok, entry} = Postgres.admit_entry(identity, :new)
    assert {:ok, _} = Postgres.confirm_admission(entry)
    entry
  end

  defp initial_entry(:sdk, identity, context) do
    result = rpc(context.bridge, %{step: :start, port: context.port, token: token(identity, 1)})
    assert result["phase"] == "live"
    %{identity | entry_generation: row(context.connection, identity).confirmed}
  end

  defp initial_entry(version, identity, context) do
    published_entry(version, "hello", identity, context)
  end

  defp published_entry(version, frame, identity, context) do
    capture = Enum.find(@captures, &(&1["version"] == version))
    {:ok, client} = Client.connect(context.port, capture["path"])
    client = Client.send_json(client, Map.put(capture[frame], "token", token(identity, 2)))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
    Client.close_tcp(client)
    %{identity | entry_generation: row(context.connection, identity).confirmed}
  end

  defp row(connection, identity) do
    [[status, seat, issued, confirmed, pending]] =
      Postgrex.query!(
        connection,
        """
        select p.status,s.state,s.issued_entry_generation,s.confirmed_entry_generation,
          (select count(*) from sync_external_operations o where o.target_participant_id=p.id and o.status='pending')
        from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1
        """,
        [UUID.dump!(identity.participant_id)]
      ).rows

    %{status: status, seat: seat, issued: issued, confirmed: confirmed, pending: pending}
  end

  defp token(identity, issued_at) do
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
      "role" => identity.role,
      "capabilities" => identity.capabilities,
      "issued_at" => issued_at,
      "expires_at" => 4_102_444_800
    })
  end

  defp start_bridge do
    script = Path.expand("../fixtures/entry-interleaving-client.mjs", __DIR__)

    Port.open({:spawn_executable, System.find_executable("node")}, [
      :binary,
      :exit_status,
      {:line, 65_536},
      args: [script]
    ])
  end

  defp rpc(port, request) do
    Port.command(port, JSON.encode!(request) <> "\n")

    receive do
      {^port, {:data, {:eol, line}}} ->
        decoded = JSON.decode!(line)
        assert Map.has_key?(decoded, "result"), "SDK bridge failed: #{line}"
        decoded["result"]

      {^port, {:exit_status, status}} ->
        flunk("SDK bridge exited #{status}")
    after
      10_000 -> flunk("SDK bridge did not finish #{request.step}")
    end
  end

  defp interleave([], right), do: [right]
  defp interleave(left, []), do: [left]

  defp interleave([left | left_tail] = left_all, [right | right_tail] = right_all) do
    Enum.map(interleave(left_tail, right_all), &[left | &1]) ++
      Enum.map(interleave(left_all, right_tail), &[right | &1])
  end

  defp before?(steps, first, second),
    do: Enum.find_index(steps, &(&1 == first)) < Enum.find_index(steps, &(&1 == second))

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)
end
