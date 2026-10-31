defmodule ChalkSync.DurableLeavePostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  defmodule DelayedProvider do
    def remove_participant(owner, operation_id, _episode, _participant_id) do
      send(owner, {:cleanup_started, operation_id, self()})

      receive do
        :release -> :satisfied
      end
    end
  end

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 4)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, fixture: fixture}
  end

  test "a caller crash after commit leaves replayable confirmation and claimable cleanup", %{
    connection: connection,
    fixture: fixture
  } do
    owner = self()
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_crash_leave_0001", :participant_leave, %{})

    {pid, monitor} =
      spawn_monitor(fn ->
        send(owner, {:committed, Postgres.begin_operation(identity, leave)})
        exit(:simulated_crash)
      end)

    assert_receive {:committed, {:ok, %{result: :applied, external_operation_id: id}}}, 5_000
    assert_receive {:DOWN, ^monitor, :process, ^pid, :simulated_crash}

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.begin_operation(identity, leave)

    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)

    assert {:error, :participant_inactive} =
             Postgres.participant_authority(
               fixture.episode,
               identity.participant_id,
               identity.participant_generation
             )

    assert {:error, :participant_inactive} =
             Postgres.reserve_publication_grant(identity, "departed_publication_001", :camera)

    _confirmation_replay = Postgres.confirm_admission(identity)
    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)
    cleanup = claim_cleanup(id)
    assert cleanup.target_participant_generation == identity.participant_generation
    assert cleanup.target_participant_id == identity.participant_id
    assert :confirmed = execute(fixture.episode, cleanup, nil)

    assert {:ok, %{status: :applied}} =
             Postgres.read_operation(fixture.episode, cleanup.external_operation_id)

    assert [[1]] = cleanup_count(connection, id)
  end

  test "Leave and its webhook are committed while a delayed cleanup provider is blocked", %{
    connection: connection,
    fixture: fixture
  } do
    SyncPostgres.seed_webhook_endpoint(fixture, connection, ["participant.left"])
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_delayed_leave_01", :participant_leave, %{})

    assert {:ok, %{result: :applied, external_operation_id: id}} =
             Postgres.begin_operation(identity, leave)

    cleanup = claim_cleanup(id)
    owner = self()
    task = Task.async(fn -> execute(fixture.episode, cleanup, {DelayedProvider, owner}) end)
    assert_receive {:cleanup_started, _, provider}, 5_000
    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.begin_operation(identity, leave)

    assert [[1, true]] =
             Postgrex.query!(
               connection,
               """
               select count(*), bool_and(outbox.occurred_at=date_trunc('milliseconds',p.left_at))
               from webhook_events outbox join participants p on p.id=$1
               where outbox.tenant_id=p.tenant_id and outbox.event_name='participant.left'
               """,
               [UUID.dump!(identity.participant_id)]
             ).rows

    send(provider, :release)
    assert :confirmed = Task.await(task)
    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)
  end

  test "cleanup exhaustion is retained without rejecting Leave or changing its timestamp", %{
    connection: connection,
    fixture: fixture
  } do
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_exhaust_leave_01", :participant_leave, %{})

    assert {:ok, %{result: :applied, external_operation_id: id}} =
             Postgres.begin_operation(identity, leave)

    cleanup = claim_cleanup(id)

    assert :pending =
             ExternalOperationConsumer.execute_operation(
               fixture.episode,
               cleanup,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99,next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(cleanup.external_operation_id)]
    )

    cleanup = claim_cleanup(id)
    assert cleanup.attempt_count == 100

    assert :terminal_failure =
             ExternalOperationConsumer.execute_operation(
               fixture.episode,
               cleanup,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :failed, last_error_code: :retry_exhausted}} =
             Postgres.read_operation(fixture.episode, cleanup.external_operation_id)

    assert {:ok, %{result: :applied, delivery: :duplicate}} =
             Postgres.begin_operation(identity, leave)

    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)
    assert {:ok, remaining} = Postgres.claim_operations(64)

    refute Enum.any?(remaining, fn {_, operation} ->
             operation.external_operation_id == cleanup.external_operation_id
           end)
  end

  test "a rejoin is admitted while old cleanup is pending and survives its completion", %{
    connection: connection,
    fixture: fixture
  } do
    fixture = SyncPostgres.seed_admission_request(connection, fixture)
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_rejoin_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :applied, external_operation_id: id}} =
             Postgres.begin_operation(identity, leave)

    cleanup = claim_cleanup(id)

    {:ok, admission} =
      Operation.new("durable_rejoin_admit_001", :admit_participant, %{
        "admissionRequestId" => fixture.admission_request_id
      })

    assert {:ok, %{external_operation_id: admission_id}} =
             Postgres.begin_operation(hd(fixture.identities), admission)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.episode, admission_id, {:confirmed, :local})

    assert :confirmed = execute(fixture.episode, cleanup, nil)

    assert [["active"]] =
             Postgrex.query!(connection, "select status from participants where id=$1", [
               UUID.dump!(fixture.admission_participant_id)
             ]).rows

    assert [["left", true]] = departure_rows(connection, identity.participant_id, id)
  end

  for outcome <- [:confirmed, :retry_exhausted],
      {kind, source} <- [
        mute_participant: "microphone",
        stop_participant_camera: "camera",
        stop_participant_screen_share: "screen"
      ] do
    @tag timeout: 180_000
    test "account reentry isolates old cleanup and #{kind} on #{outcome}", %{
      connection: connection,
      fixture: fixture
    } do
      assert_account_reentry(
        connection,
        fixture,
        unquote(outcome),
        unquote(kind),
        unquote(source),
        "confirmed"
      )
    end
  end

  for {kind, source} <- [
        mute_participant: "microphone",
        stop_participant_camera: "camera",
        stop_participant_screen_share: "screen"
      ] do
    @tag timeout: 180_000
    test "account reentry isolates terminal failure of old #{kind}", %{
      connection: connection,
      fixture: fixture
    } do
      assert_account_reentry(
        connection,
        fixture,
        :confirmed,
        unquote(kind),
        unquote(source),
        "terminal_failure"
      )
    end
  end

  defp assert_account_reentry(connection, fixture, outcome, kind, source, media_outcome) do
    episode = fixture.episode
    account = UUID.generate()

    Postgrex.query!(
      connection,
      "insert into users(id,name,email) values($1,'Reentry test',$2)",
      [UUID.dump!(account), account <> "@example.invalid"]
    )

    on_exit(fn ->
      SyncPostgres.cleanup(connection, episode)
      Postgrex.query!(connection, "delete from users where id=$1", [UUID.dump!(account)])
    end)

    SyncPostgres.seed_webhook_endpoint(fixture, connection, ["participant.left"])
    old = account_join(episode, account, "reentry_first_join")
    assert {:ok, old} = Postgres.admit_entry(old, :new)
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(old)

    {:ok, mute} =
      Operation.new("reentry_old_mute_001", kind, %{
        "participantId" => old.participant_id
      })

    assert {:ok, %{result: :pending, external_operation_id: mute_id}} =
             Postgres.begin_operation(hd(fixture.identities), mute)

    {:ok, leave} = Operation.new("reentry_departure_001", :participant_leave, %{})

    assert {:ok, %{result: :applied, external_operation_id: departure_id} = departure} =
             Postgres.begin_operation(old, leave)

    cleanup = claim_cleanup(departure_id)
    assert cleanup.target_participant_id == old.participant_id
    assert cleanup.target_participant_generation == old.participant_generation
    assert cleanup.payload["departureOperationId"] == departure_id
    before_departure = departure_snapshot(connection, episode, old.participant_id, departure_id)
    assert [[%DateTime{}, "committed", %{}, [%{}], 1, 1, 1]] = before_departure

    owner = self()
    {:ok, media} = Agent.start_link(fn -> %{} end)

    transport = fn :post, url, _headers, body, _options ->
      payload = JSON.decode!(body)
      id = url |> URI.parse() |> Map.fetch!(:path) |> Path.basename()
      send(owner, {:provider_call, id, payload, self()})

      result =
        if id == cleanup.external_operation_id do
          receive do
            {:release, result} -> result
          end
        else
          Map.get(%{mute_id => media_outcome}, id, "confirmed")
        end

      if result == "confirmed" do
        Agent.update(
          media,
          &Map.delete(&1, {payload["participant_id"], payload["participant_generation"]})
        )
      end

      {:ok, 200, [],
       JSON.encode!(%{"operation_id" => id, "effect" => payload["effect"], "outcome" => result})}
    end

    adapter =
      Client.new!(base_url: "http://localhost:4000", transport: transport) |> MediaPlane.new!()

    task =
      Task.async(fn ->
        ExternalOperationConsumer.execute_operation(
          episode,
          cleanup,
          {MediaPlane, adapter},
          nil,
          &Postgres.finalize_operation/3,
          180_000
        )
      end)

    assert_receive {:provider_call, cleanup_id, cleanup_payload, provider}, 5_000
    assert cleanup_id == cleanup.external_operation_id
    assert cleanup_payload["effect"] == "media.remove_participant"
    assert cleanup_payload["participant_id"] == old.participant_id
    assert cleanup_payload["participant_generation"] == old.participant_generation

    current = account_join(episode, account, "reentry_second_join")
    assert current.participant_id != old.participant_id
    assert current.participant_generation > old.participant_generation
    assert {:ok, current} = Postgres.admit_entry(current, :new)
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(current)

    Agent.update(
      media,
      &Map.put(&1, {current.participant_id, current.participant_generation}, :active)
    )

    assert {:ok, grant} =
             Postgres.reserve_publication_grant(current, "reentry_current_camera_001", :camera)

    assert {:ok, %{status: :confirmed, result: :authorized}} =
             Postgres.complete_publication_grant(episode, grant.reservation_id, :confirmed)

    {:ok, current_stop} =
      Operation.new("reentry_current_stop_001", :stop_participant_screen_share, %{
        "participantId" => current.participant_id
      })

    assert {:ok, %{result: :pending, external_operation_id: current_stop_id}} =
             Postgres.begin_operation(hd(fixture.identities), current_stop)

    send(provider, {:release, if(outcome == :confirmed, do: "confirmed", else: "ambiguous")})

    assert Task.await(task, 180_000) ==
             if(outcome == :confirmed, do: :confirmed, else: :pending)

    if outcome == :retry_exhausted do
      Postgrex.query!(
        connection,
        "update sync_external_operations set attempt_count=99,next_attempt_at=now() where external_operation_id=$1",
        [UUID.dump!(cleanup.external_operation_id)]
      )

      assert %{attempt_count: 100} = retry = claim_cleanup(departure_id)

      assert :terminal_failure =
               ExternalOperationConsumer.execute_operation(
                 episode,
                 retry,
                 {MediaPlane, adapter},
                 nil,
                 &Postgres.finalize_operation/3
               )
    end

    status = if outcome == :confirmed, do: :applied, else: :failed

    settlement =
      if outcome == :confirmed, do: {:confirmed, :provider}, else: {:failed, :retry_exhausted}

    assert {:ok, %{status: ^status}} =
             Postgres.read_operation(episode, cleanup.external_operation_id)

    assert {:ok, %{result: ^status, delivery: :duplicate}} =
             Postgres.finalize_operation(episode, cleanup.external_operation_id, settlement)

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(mute_id)]
    )

    assert {:ok, operations} = Postgres.claim_operations(64)

    assert {^episode, old_mute} =
             Enum.find(operations, fn {_, op} -> op.external_operation_id == mute_id end)

    assert old_mute.attempt_count < 100

    Postgrex.query!(
      connection,
      """
      insert into sync_publication_fences
        (tenant_id, space_id, episode_id, participant_id, participant_generation, source,
         external_operation_id, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')
      """,
      [
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.episode_id),
        UUID.dump!(old.participant_id),
        old.participant_generation,
        source,
        UUID.dump!(mute_id)
      ]
    )

    assert [[1]] =
             Postgrex.query!(
               connection,
               "select count(*) from sync_publication_fences where external_operation_id=$1",
               [UUID.dump!(mute_id)]
             ).rows

    expected_media_result =
      %{"confirmed" => :confirmed, "terminal_failure" => :terminal_failure}[media_outcome]

    assert ^expected_media_result =
             ExternalOperationConsumer.execute_operation(
               episode,
               old_mute,
               {MediaPlane, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert_receive {:provider_call, ^mute_id, mute_payload, _}, 5_000
    assert mute_payload["effect"] == "media.revoke_publication"
    assert mute_payload["participant_id"] == old.participant_id
    assert mute_payload["participant_generation"] == old.participant_generation
    assert mute_payload["publication_source"] == source

    assert {:ok, %{status: :failed, last_error_code: :stale_participant_generation}} =
             Postgres.read_operation(episode, mute_id)

    media_settlement =
      %{
        "confirmed" => {:confirmed, :provider},
        "terminal_failure" => {:failed, :provider_rejected}
      }[media_outcome]

    assert {:ok, %{result: :failed, delivery: :duplicate}} =
             Postgres.finalize_operation(episode, mute_id, media_settlement)

    assert [["rejected", "external_operation_failed", 1]] =
             Postgrex.query!(
               connection,
               "select outcome, rejection_reason, count(*) over() from sync_command_receipts where external_operation_id=$1",
               [UUID.dump!(mute_id)]
             ).rows

    assert [[0]] =
             Postgrex.query!(
               connection,
               "select count(*) from sync_publication_fences where external_operation_id=$1",
               [UUID.dump!(mute_id)]
             ).rows

    refute_receive {:provider_call, _, _, _}, 0

    assert Agent.get(
             media,
             &Map.get(&1, {current.participant_id, current.participant_generation})
           ) == :active

    assert {:ok, %{generation: current_generation}} =
             Postgres.participant_authority(
               episode,
               current.participant_id,
               current.participant_generation
             )

    assert current_generation == current.participant_generation

    assert [["active", "joined", generation, "confirmed", 1]] =
             Postgrex.query!(
               connection,
               """
               select p.status, s.state, s.generation, r.status,
                 (select count(*) from sync_publication_fences where participant_id=p.id and participant_generation=p.generation)
               from participants p join participant_join_seats s on s.participant_id=p.id
               join sync_publication_grant_reservations r on r.participant_id=p.id and r.participant_generation=p.generation
               where p.id=$1
               """,
               [UUID.dump!(current.participant_id)]
             ).rows

    assert generation == current.participant_generation

    assert [[current_fence_id]] =
             Postgrex.query!(
               connection,
               "select external_operation_id from sync_publication_fences where participant_id=$1 and participant_generation=$2 and source='screen'",
               [UUID.dump!(current.participant_id), current.participant_generation]
             ).rows

    assert UUID.load!(current_fence_id) == current_stop_id

    assert departure_snapshot(connection, episode, old.participant_id, departure_id) ==
             before_departure

    assert {:ok, %{result: :applied, delivery: :duplicate, event_id: event_id}} =
             Postgres.begin_operation(old, leave)

    assert event_id == departure.event_id

    assert departure_snapshot(connection, episode, old.participant_id, departure_id) ==
             before_departure

    assert [[0]] =
             Postgrex.query!(
               connection,
               "select count(*) from webhook_events where tenant_id=$1 and resource_id=$2 and event_name='participant.left'",
               [UUID.dump!(episode.tenant_id), UUID.dump!(current.participant_id)]
             ).rows
  end

  defp account_join(episode, account, key) do
    {output, status} =
      System.cmd(
        "go",
        ["run", "./tests/sync-reentry", episode.tenant_id, episode.space_id, account, key],
        cd: Path.expand("../../../api", __DIR__),
        stderr_to_stdout: true
      )

    assert status == 0, output
    result = JSON.decode!(output)

    %Identity{
      episode: episode,
      participant_id: result["participant_id"],
      participant_generation: result["generation"],
      admission_lifecycle_intent_id: result["intent_id"],
      role: result["role"],
      capabilities: result["capabilities"]
    }
  end

  defp departure_snapshot(connection, episode, participant_id, departure_id) do
    Postgrex.query!(
      connection,
      """
      select p.left_at, r.outcome, to_jsonb(r),
        (select jsonb_agg(to_jsonb(e) order by e.id) from webhook_events e where e.tenant_id=$1 and e.resource_id=$2 and e.event_name='participant.left'),
        (select count(*) from webhook_events where tenant_id=$1 and resource_id=$2 and event_name='participant.left'),
        (select count(*) from sync_command_receipts where external_operation_id=$3),
        (select count(*) from webhook_deliveries d join webhook_events e on e.id=d.event_id where e.tenant_id=$1 and e.resource_id=$2 and e.event_name='participant.left')
      from participants p join sync_command_receipts r on r.external_operation_id=$3 where p.id=$2
      """,
      [UUID.dump!(episode.tenant_id), UUID.dump!(participant_id), UUID.dump!(departure_id)]
    ).rows
  end

  test "a crash on the last cleanup claim can still settle exhaustion", %{
    connection: connection,
    fixture: fixture
  } do
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_last_claim_0001", :participant_leave, %{})
    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(identity, leave)
    cleanup = claim_cleanup(id)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99,next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(cleanup.external_operation_id)]
    )

    assert %{attempt_count: 100} = claim_cleanup(id)

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(cleanup.external_operation_id)]
    )

    reclaimed = claim_cleanup(id)
    assert reclaimed.attempt_count == 100

    assert :terminal_failure =
             ExternalOperationConsumer.execute_operation(
               fixture.episode,
               reclaimed,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :failed}} =
             Postgres.read_operation(fixture.episode, cleanup.external_operation_id)
  end

  test "departure and cleanup roll back together before commit", %{
    connection: connection,
    fixture: fixture
  } do
    identity = List.last(fixture.identities)
    {:ok, leave} = Operation.new("durable_atomic_leave_001", :participant_leave, %{})

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, _context ->
      if point == :after_webhook_production, do: raise("transaction interrupted")
    end)

    on_exit(fn -> Application.delete_env(:chalk_sync, :external_operation_fault_hook) end)

    assert {:retryable, :decision_unavailable} = Postgres.begin_operation(identity, leave)

    assert [["active"]] =
             Postgrex.query!(connection, "select status from participants where id=$1", [
               UUID.dump!(identity.participant_id)
             ]).rows

    assert [[0]] =
             Postgrex.query!(
               connection,
               "select count(*) from sync_external_operations where tenant_id=$1",
               [UUID.dump!(fixture.episode.tenant_id)]
             ).rows
  end

  for kind <- [:remove_participant, :mute_participant],
      outcome <- [:confirmed, :retry_exhausted] do
    @tag :actor_departure_settlement
    test "accepted #{kind} settles #{outcome} after its actor Leaves", %{
      connection: connection,
      fixture: fixture
    } do
      kind = unquote(kind)
      outcome = unquote(outcome)
      [actor, target] = fixture.identities
      SyncPostgres.seed_webhook_endpoint(fixture, connection, ["participant.left"])

      {:ok, action} =
        Operation.new("actor_departure_action_01", kind, %{
          "participantId" => target.participant_id
        })

      assert {:ok, %{result: :pending, external_operation_id: action_id}} =
               Postgres.begin_operation(actor, action)

      {:ok, leave} = Operation.new("actor_departure_leave_001", :participant_leave, %{})
      assert {:ok, %{result: :applied}} = Postgres.begin_operation(actor, leave)

      {:ok, later_action} =
        Operation.new("actor_departure_action_02", kind, %{
          "participantId" => target.participant_id
        })

      assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
               Postgres.begin_operation(actor, later_action)

      settlement =
        if outcome == :confirmed,
          do: {:confirmed, :provider},
          else: {:failed, :retry_exhausted}

      expected_status = if outcome == :confirmed, do: :applied, else: :failed

      assert {:ok, %{result: ^expected_status}} =
               Postgres.finalize_operation(fixture.episode, action_id, settlement)

      assert {:ok, %{result: ^expected_status, delivery: :duplicate}} =
               Postgres.finalize_operation(fixture.episode, action_id, settlement)

      removed = kind == :remove_participant and outcome == :confirmed
      target_status = if removed, do: "left", else: "active"
      operation_status = Atom.to_string(expected_status)
      receipt_outcome = if outcome == :confirmed, do: "committed", else: "rejected"

      assert [[^target_status, ^operation_status, ^receipt_outcome, 0]] =
               Postgrex.query!(
                 connection,
                 """
                 select participant.status, operation.status, receipt.outcome,
                   count(fence.external_operation_id)
                 from participants participant
                 join sync_external_operations operation on operation.external_operation_id=$1
                 join sync_command_receipts receipt using(external_operation_id)
                 left join sync_publication_fences fence
                   on fence.external_operation_id=operation.external_operation_id
                 where participant.id=$2
                 group by participant.status,operation.status,receipt.outcome
                 """,
                 [UUID.dump!(action_id), UUID.dump!(target.participant_id)]
               ).rows

      webhook_count = if removed, do: 1, else: 0

      assert [[^webhook_count]] =
               Postgrex.query!(
                 connection,
                 """
                 select count(*) from webhook_events
                 where tenant_id=$1 and resource_id=$2 and event_name='participant.left'
                 """,
                 [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(target.participant_id)]
               ).rows
    end
  end

  defp claim_cleanup(id) do
    assert {:ok, operations} = Postgres.claim_operations(64)

    {_, cleanup} =
      Enum.find(operations, fn {_, operation} ->
        operation.name == :remove_participant and
          operation.payload["departureOperationId"] == id
      end)

    cleanup
  end

  defp execute(episode, cleanup, nil) do
    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    execute(episode, cleanup, {MediaPlaneTestAdapter, adapter})
  end

  defp execute(episode, cleanup, adapter),
    do:
      ExternalOperationConsumer.execute_operation(
        episode,
        cleanup,
        adapter,
        nil,
        &Postgres.finalize_operation/3
      )

  defp departure_rows(connection, participant_id, id) do
    Postgrex.query!(
      connection,
      "select p.status,p.left_at=operation.created_at from participants p join sync_external_operations operation on operation.external_operation_id=$2 where p.id=$1",
      [UUID.dump!(participant_id), UUID.dump!(id)]
    ).rows
  end

  defp cleanup_count(connection, id) do
    Postgrex.query!(
      connection,
      "select count(*) from sync_external_operations where payload->>'departureOperationId'=$1",
      [id]
    ).rows
  end
end
