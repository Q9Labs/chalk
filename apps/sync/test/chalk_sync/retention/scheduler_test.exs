defmodule ChalkSync.Retention.SchedulerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Retention.Scheduler

  test "records bounded cleanup results without retaining identifiers" do
    cleanup = fn ->
      {:ok,
       %Result{
         sessions: 2,
         event_rows: 11,
         event_bytes: 110,
         receipt_rows: 7,
         receipt_bytes: 70,
         lifecycle_intent_rows: 3,
         lifecycle_intent_bytes: 30
       }}
    end

    server =
      start_supervised!({Scheduler, name: nil, auto_run?: false, cleanup_fun: cleanup})

    assert {:ok, %Result{sessions: 2}} = Scheduler.run_now(server)

    health = Scheduler.health(server)
    assert health.cleaned_sessions == 2
    assert health.deleted_event_rows == 11
    refute inspect(health) =~ "tenant"
    refute inspect(health) =~ "session_id"
  end

  test "reports aggregate cleanup counters and recovers after a failed batch" do
    {:ok, attempts} = Agent.start_link(fn -> 0 end)

    cleanup = fn ->
      case Agent.get_and_update(attempts, fn count -> {count, count + 1} end) do
        0 -> {:error, :database_unavailable}
        _ -> {:ok, %Result{sessions: 1, event_rows: 2, receipt_rows: 3}}
      end
    end

    start_supervised!(
      {Scheduler, name: :retention_scheduler_test, auto_run?: false, cleanup_fun: cleanup}
    )

    assert Scheduler.run_now(:retention_scheduler_test) == {:error, :database_unavailable}
    assert Scheduler.health(:retention_scheduler_test).status == "degraded"

    assert {:ok, %Result{sessions: 1}} = Scheduler.run_now(:retention_scheduler_test)

    assert %{
             status: "ok",
             consecutive_failures: 0,
             cleaned_sessions: 1,
             deleted_event_rows: 2,
             deleted_receipt_rows: 3,
             deleted_lifecycle_intent_rows: 0
           } = Scheduler.health(:retention_scheduler_test)
  end

  test "health stays responsive while cleanup is blocked" do
    parent = self()

    cleanup = fn ->
      send(parent, {:cleanup_started, self()})

      receive do
        :release -> {:ok, %Result{}}
      end
    end

    server =
      start_supervised!({Scheduler, name: nil, auto_run?: false, cleanup_fun: cleanup})

    run = Task.async(fn -> Scheduler.run_now(server) end)
    assert_receive {:cleanup_started, cleanup_pid}

    health = Task.async(fn -> Scheduler.health(server) end)
    assert %{status: "ok"} = Task.await(health, 100)

    send(cleanup_pid, :release)
    assert {:ok, %Result{}} = Task.await(run)
  end
end
