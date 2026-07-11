defmodule ChalkSync.SyncBreaker.FaultScenarios do
  @moduledoc false

  alias ChalkSync.Rooms.Room
  alias ChalkSync.Rooms.RoomServer
  alias ChalkSync.ScriptedStateholder
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.SyncBreaker.Result

  def commit_ambiguity(seed) do
    with_scripted_stateholder(fn -> run_commit_ambiguity(seed) end)
  end

  def writer_conflict_orphan(seed) do
    with_scripted_stateholder(fn -> run_writer_conflict_orphan(seed) end)
  end

  def idempotency_eviction(seed, remembered_limit \\ 256) do
    room_id = room_id("idempotency-eviction", seed)
    subscriber = draining_subscriber()

    try do
      {:ok, writer, _reply} = RoomServer.join(room_id, "p1", "Ada", subscriber)

      {:committed, first_revision} =
        RoomServer.command(room_id, "p1", "original", :raise_hand, %{})

      {:committed, _revision} = RoomServer.command(room_id, "p1", "lower", :lower_hand, %{})

      Enum.each(1..remembered_limit, fn index ->
        {:rejected, :unknown_command} =
          RoomServer.command(room_id, "p1", "filler-#{index}", :invalid, %{})
      end)

      retry = RoomServer.command(room_id, "p1", "original", :raise_hand, %{})

      if retry == {:duplicate, first_revision} do
        Result.pass("idempotency_eviction",
          seed: seed,
          evidence: %{"retry" => inspect(retry)},
          trace: [%{"action" => "retry_original", "result" => inspect(retry)}]
        )
      else
        Result.fail(
          "idempotency_eviction",
          :idempotency_retention,
          "a retried command changed outcome after the writer's remembered-command bound",
          seed: seed,
          evidence: %{
            "expected" => inspect({:duplicate, first_revision}),
            "observed" => inspect(retry),
            "remembered_limit" => remembered_limit,
            "writer" => inspect(writer)
          },
          trace: [
            %{"action" => "original", "result" => "committed", "revision" => first_revision},
            %{"action" => "fill_idempotency", "count" => remembered_limit},
            %{"action" => "retry_original", "result" => inspect(retry)}
          ]
        )
      end
    after
      stop_subscriber(subscriber)
    end
  end

  def slow_subscriber(seed, event_count \\ 1_000, mailbox_bound \\ 128) do
    room_id = room_id("slow-subscriber", seed)
    slow = idle_subscriber()
    fast = draining_subscriber()

    try do
      {:ok, _writer, _reply} = RoomServer.join(room_id, "slow", "Slow", slow)
      {:ok, _writer, _reply} = RoomServer.join(room_id, "fast", "Fast", fast)

      Enum.each(1..event_count, fn index ->
        command = if rem(index, 2) == 1, do: :raise_hand, else: :lower_hand
        {:committed, _revision} = RoomServer.command(room_id, "fast", "c-#{index}", command, %{})
      end)

      {:message_queue_len, queue_length} = Process.info(slow, :message_queue_len)

      if queue_length <= mailbox_bound do
        Result.pass("slow_subscriber",
          seed: seed,
          evidence: %{"message_queue_len" => queue_length},
          trace: [%{"action" => "sample_mailbox", "message_queue_len" => queue_length}]
        )
      else
        Result.fail(
          "slow_subscriber",
          :bounded_fanout,
          "a non-reading subscriber accumulated unbounded sync fanout",
          seed: seed,
          evidence: %{
            "events" => event_count,
            "mailbox_bound" => mailbox_bound,
            "message_queue_len" => queue_length
          },
          trace: [
            %{"action" => "join_slow_subscriber"},
            %{"action" => "commit_events", "count" => event_count},
            %{"action" => "sample_mailbox", "message_queue_len" => queue_length}
          ]
        )
      end
    after
      stop_subscriber(slow)
      stop_subscriber(fast)
    end
  end

  def retention_snapshot_fallback(seed, retained_events \\ 500) do
    room_id = room_id("retention-snapshot", seed)
    original = draining_subscriber()
    reconnect = draining_subscriber()

    try do
      {:ok, _writer, _reply} = RoomServer.join(room_id, "p1", "Ada", original)

      Enum.each(1..(retained_events + 2), fn index ->
        command = if rem(index, 2) == 1, do: :raise_hand, else: :lower_hand
        {:committed, _revision} = RoomServer.command(room_id, "p1", "c-#{index}", command, %{})
      end)

      {:ok, _writer, reply} = RoomServer.join(room_id, "p1", "Ada", reconnect, 1)
      {:ok, room} = Stateholder.load(room_id)
      expected_snapshot = Room.snapshot(room)

      evidence = %{
        "cursor" => 1,
        "control_revision" => room.revision,
        "mode" => if(is_map(reply.snapshot), do: "snapshot", else: "replay"),
        "snapshot_matches" => reply.snapshot == expected_snapshot
      }

      if reply.replay == nil and reply.snapshot == expected_snapshot do
        Result.pass("retention_snapshot_fallback",
          seed: seed,
          invariant: :retention_convergence,
          message: "an expired replay cursor converged through an authoritative snapshot",
          evidence: evidence,
          trace: [
            %{"action" => "advance_beyond_retention", "events" => retained_events + 2},
            %{"action" => "reconnect", "cursor" => 1, "mode" => "snapshot"},
            %{"action" => "compare_snapshot", "matches" => true}
          ]
        )
      else
        Result.fail(
          "retention_snapshot_fallback",
          :retention_convergence,
          "an expired replay cursor did not return the authoritative snapshot",
          seed: seed,
          evidence: evidence,
          trace: [
            %{"action" => "advance_beyond_retention", "events" => retained_events + 2},
            %{"action" => "reconnect", "cursor" => 1, "reply" => inspect(reply)}
          ]
        )
      end
    after
      stop_subscriber(original)
      stop_subscriber(reconnect)
    end
  end

  def multiple_subscriptions_lifecycle(seed) do
    room_id = room_id("multiple-subscriptions", seed)
    first = idle_subscriber()
    second = idle_subscriber()

    try do
      {:ok, writer, _reply} = RoomServer.join(room_id, "p1", "Ada", first)
      {:ok, ^writer, _reply} = RoomServer.join(room_id, "p1", "Ada", second)
      {:ok, room_before} = Stateholder.load(room_id)

      stop_subscriber(first)
      {:ok, state} = await_subscriber_count(writer, 1, 2_000)
      {:ok, room_after_close} = Stateholder.load(room_id)
      command_result = RoomServer.command(room_id, "p1", "after-close", :raise_hand, %{})
      {:ok, room_after_command} = Stateholder.load(room_id)

      evidence = %{
        "revision_before" => room_before.revision,
        "revision_after_close" => room_after_close.revision,
        "revision_after_command" => room_after_command.revision,
        "remaining_subscribers" => map_size(state.subscribers),
        "command_result" => inspect(command_result)
      }

      if room_after_close.revision == room_before.revision and
           Map.has_key?(room_after_close.participants, "p1") and
           command_result == {:committed, room_before.revision + 1} do
        Result.pass("multiple_subscriptions_lifecycle",
          seed: seed,
          invariant: :subscription_lifecycle,
          message: "closing one subscription preserved the participant and remaining writer",
          evidence: evidence,
          trace: [
            %{"action" => "join_two_subscriptions", "revision" => room_before.revision},
            %{"action" => "close_one_subscription", "revision" => room_after_close.revision},
            %{
              "action" => "command_on_remaining_subscription",
              "result" => inspect(command_result)
            }
          ]
        )
      else
        Result.fail(
          "multiple_subscriptions_lifecycle",
          :subscription_lifecycle,
          "closing one of multiple subscriptions changed participant lifecycle state",
          seed: seed,
          evidence: evidence,
          trace: [
            %{"action" => "join_two_subscriptions", "revision" => room_before.revision},
            %{"action" => "close_one_subscription", "revision" => room_after_close.revision},
            %{
              "action" => "command_on_remaining_subscription",
              "result" => inspect(command_result)
            }
          ]
        )
      end
    after
      stop_subscriber(first)
      stop_subscriber(second)
    end
  end

  defp run_commit_ambiguity(seed) do
    room_id = room_id("commit-ambiguity", seed)
    subscriber = draining_subscriber()

    try do
      {:ok, writer, _reply} = RoomServer.join(room_id, "p1", "Ada", subscriber)
      writer_ref = Process.monitor(writer)
      :ok = ScriptedStateholder.arm(:commit, {:block_after, self(), :after_commit})

      task =
        Task.async(fn -> RoomServer.command(room_id, "p1", "ambiguous", :raise_hand, %{}) end)

      checkpoint =
        receive do
          {:sync_breaker_checkpoint, :after_commit, :commit, :after, stateholder, ^writer} ->
            %{stateholder: stateholder, writer: writer}
        after
          2_000 -> raise "commit checkpoint was not reached"
        end

      Process.exit(writer, :kill)
      assert_down(writer_ref, writer)
      :ok = ScriptedStateholder.release(checkpoint.stateholder, :after_commit)
      first_result = Task.await(task)

      assert_room_revision(room_id, 2)
      {:ok, _new_writer, _reply} = RoomServer.join(room_id, "p1", "Ada", subscriber, 2)
      retry = RoomServer.command(room_id, "p1", "ambiguous", :raise_hand, %{})

      if first_result == {:rejected, :retry} and retry == {:duplicate, 2} do
        Result.pass("commit_ambiguity",
          seed: seed,
          trace: [
            %{"checkpoint" => "stateholder.after_commit"},
            %{"action" => "retry", "result" => inspect(retry)}
          ]
        )
      else
        Result.fail(
          "commit_ambiguity",
          :commit_acknowledgement,
          "authoritative state committed without a recoverable acknowledgement result",
          seed: seed,
          evidence: %{
            "authoritative_revision" => 2,
            "first_result" => inspect(first_result),
            "retry_result" => inspect(retry)
          },
          trace: [
            %{"checkpoint" => "stateholder.after_commit", "writer" => inspect(writer)},
            %{"action" => "kill_writer"},
            %{"action" => "first_result", "result" => inspect(first_result)},
            %{"action" => "retry", "result" => inspect(retry)}
          ]
        )
      end
    after
      stop_subscriber(subscriber)
    end
  end

  defp run_writer_conflict_orphan(seed) do
    room_id = room_id("writer-conflict", seed)
    subscriber = draining_subscriber()

    try do
      {:ok, writer, _reply} = RoomServer.join(room_id, "p1", "Ada", subscriber)
      writer_ref = Process.monitor(writer)
      :ok = ScriptedStateholder.arm(:commit, :revision_conflict)

      result = RoomServer.command(room_id, "p1", "conflict", :raise_hand, %{})
      assert_down(writer_ref, writer)

      cleanup = observe_writer_cleanup(room_id, writer, 2_000)
      writer_conflict_result(seed, writer, result, cleanup)
    after
      stop_subscriber(subscriber)
      terminate_writer(room_id)
    end
  end

  defp with_scripted_stateholder(fun) do
    previous = Application.fetch_env!(:chalk_sync, :stateholder)
    {:ok, stateholder} = ScriptedStateholder.start_link()
    Application.put_env(:chalk_sync, :stateholder, ScriptedStateholder)

    try do
      fun.()
    after
      Application.put_env(:chalk_sync, :stateholder, previous)

      if Process.alive?(stateholder) do
        GenServer.stop(stateholder)
      end
    end
  end

  defp assert_down(reference, pid) do
    receive do
      {:DOWN, ^reference, :process, ^pid, _reason} -> :ok
    after
      2_000 -> raise "writer #{inspect(pid)} did not stop"
    end
  end

  defp assert_room_revision(room_id, expected) do
    case Stateholder.load(room_id) do
      {:ok, %{revision: ^expected}} -> :ok
      other -> raise "expected authoritative revision #{expected}, got #{inspect(other)}"
    end
  end

  defp observe_writer_cleanup(room_id, previous, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout

    case await_restarted_writer(room_id, previous, deadline) do
      :absent -> :absent
      restarted -> await_writer_exit(restarted, deadline)
    end
  end

  defp await_restarted_writer(room_id, previous, deadline) do
    case RoomServer.whereis(room_id) do
      pid when is_pid(pid) and pid != previous ->
        pid

      _ ->
        if System.monotonic_time(:millisecond) >= deadline do
          :absent
        else
          receive do
          after
            1 -> await_restarted_writer(room_id, previous, deadline)
          end
        end
    end
  end

  defp await_writer_exit(writer, deadline) do
    reference = Process.monitor(writer)
    timeout = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:DOWN, ^reference, :process, ^writer, _reason} -> :absent
    after
      timeout ->
        Process.demonitor(reference, [:flush])
        writer_state(writer)
    end
  end

  defp writer_state(writer) do
    {:alive, writer, :sys.get_state(writer)}
  catch
    :exit, _reason -> :absent
  end

  defp writer_conflict_result(seed, _writer, {:rejected, :retry}, :absent) do
    Result.pass("writer_conflict_orphan",
      seed: seed,
      trace: [
        %{"fault" => "revision_conflict"},
        %{"result" => inspect({:rejected, :retry})},
        %{"writer_cleanup" => "absent"}
      ]
    )
  end

  defp writer_conflict_result(seed, writer, result, {:alive, restarted, state}) do
    Result.fail(
      "writer_conflict_orphan",
      :empty_writer_cleanup,
      "an abnormal writer restart left a live room process after its subscribers disappeared",
      seed: seed,
      evidence: %{
        "old_writer" => inspect(writer),
        "restarted_writer" => inspect(restarted),
        "result" => inspect(result),
        "subscribers" => map_size(state.subscribers)
      },
      trace: [
        %{"fault" => "revision_conflict"},
        %{"result" => inspect(result)},
        %{"writer_restarted" => inspect(restarted), "subscribers" => map_size(state.subscribers)}
      ]
    )
  end

  defp writer_conflict_result(seed, writer, result, :absent) do
    Result.fail(
      "writer_conflict_orphan",
      :fault_observation,
      "the injected revision conflict did not return the expected retry outcome",
      seed: seed,
      evidence: %{"old_writer" => inspect(writer), "result" => inspect(result)},
      trace: [%{"fault" => "revision_conflict"}, %{"result" => inspect(result)}]
    )
  end

  defp await_subscriber_count(writer, expected, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    await_subscriber_count_until(writer, expected, deadline)
  end

  defp await_subscriber_count_until(writer, expected, deadline) do
    state = :sys.get_state(writer)

    cond do
      map_size(state.subscribers) == expected ->
        {:ok, state}

      System.monotonic_time(:millisecond) >= deadline ->
        {:error, {:subscriber_count, map_size(state.subscribers), expected}}

      true ->
        receive do
        after
          1 -> await_subscriber_count_until(writer, expected, deadline)
        end
    end
  end

  defp terminate_writer(room_id) do
    case RoomServer.whereis(room_id) do
      nil -> :ok
      pid -> DynamicSupervisor.terminate_child(ChalkSync.Rooms.Supervisor, pid)
    end
  end

  defp idle_subscriber do
    spawn(fn ->
      receive do
        :stop -> :ok
      end
    end)
  end

  defp draining_subscriber do
    spawn(fn -> drain_subscriber() end)
  end

  defp drain_subscriber do
    receive do
      {:sync_event, _event} -> drain_subscriber()
      :stop -> :ok
    end
  end

  defp stop_subscriber(pid) do
    if Process.alive?(pid) do
      reference = Process.monitor(pid)
      send(pid, :stop)

      receive do
        {:DOWN, ^reference, :process, ^pid, _reason} -> :ok
      after
        2_000 -> Process.exit(pid, :kill)
      end
    end
  end

  defp room_id(prefix, seed),
    do: "breaker-#{prefix}-#{seed}-#{System.unique_integer([:positive])}"

  def memory_stateholder?, do: Stateholder.impl() == Memory
end
