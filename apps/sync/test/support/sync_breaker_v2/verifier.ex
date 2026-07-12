defmodule ChalkSync.SyncBreakerV2.Verifier do
  @moduledoc false

  alias ChalkSync.ProtocolV2
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncBreakerV2.Replica

  def verify(config, adapter, fixtures, trace) do
    fixtures
    |> Enum.reduce_while({:ok, trace, []}, &verify_next_fixture(config, adapter, &1, &2))
    |> verification_result()
  end

  def failed_result(name, detail, trace) do
    %{
      verdict: "FAIL",
      invariants: [fail_invariant(name, detail)],
      error: detail,
      trace: trace,
      metrics: %{"trace_records" => length(trace)}
    }
  end

  def setup_trace(config) do
    %{
      "kind" => "setup",
      "adapter" => Atom.to_string(config.adapter),
      "seed" => config.seed,
      "sessions" => config.sessions,
      "operation_count" => config.operation_count
    }
  end

  def verdict_trace(result) do
    %{
      "kind" => "verdict",
      "verdict" => result.verdict,
      "invariants" => result.invariants
    }
  end

  defp verify_fixture(config, adapter, fixture, trace) do
    initial_cursor = cursor(Replica.new())

    with {:ok, recovery} <- recover(adapter, fixture.session, initial_cursor),
         {:ok, audit} <- audit_fixture(adapter, fixture.session, recovery.head) do
      verify_audit(config, adapter, fixture.session, audit, trace)
    else
      {:error, reason} -> fixture_error(fixture.session, :audit, reason, trace)
      reason -> fixture_error(fixture.session, :audit, reason, trace)
    end
  end

  defp audit_fixture(adapter, session, head) do
    with {:ok, events} <- fetch_recovery_events(adapter, session, 0, head.revision, []),
         {:ok, replica, event_frames} <- replay_events(events, session.session_id) do
      {:ok, %{events: events, event_frames: event_frames, head: head, replica: replica}}
    end
  end

  defp verify_audit(config, adapter, session, audit, trace) do
    next_trace = trace ++ audit.event_frames ++ [final_head_trace(session, audit.head)]
    recovery_history = %{events: audit.events, head: audit.head}

    with :ok <- match_head(audit.replica, audit.head),
         {:ok, snapshot} <- recover(adapter, session, nil),
         :snapshot <- snapshot.mode,
         :ok <- match_head(audit.replica, snapshot.head),
         :ok <- match_snapshot(audit.replica, snapshot.snapshot),
         :ok <- converge_replicas(config, adapter, session, recovery_history, audit.replica) do
      {:ok, next_trace, %{session: session.session_id, revision: audit.head.revision}}
    else
      {:error, reason} -> fixture_error(session, :verification, reason, next_trace)
      reason -> fixture_error(session, :verification, reason, next_trace)
    end
  end

  defp final_head_trace(session, head) do
    %{
      "kind" => "final_head",
      "session_id" => session.session_id,
      "revision" => head.revision,
      "state_digest" => Base.encode16(head.digest, case: :lower)
    }
  end

  defp fixture_error(session, stage, reason, trace) do
    detail = "session #{session.session_id} #{stage}: #{inspect(reason)}"
    {:error, detail, trace}
  end

  defp verify_next_fixture(config, adapter, fixture, {:ok, trace, metrics}) do
    case verify_fixture(config, adapter, fixture, trace) do
      {:ok, next_trace, metric} -> {:cont, {:ok, next_trace, [metric | metrics]}}
      {:error, failure, next_trace} -> {:halt, {:error, failure, next_trace}}
    end
  end

  defp verification_result({:ok, trace, metrics}), do: passed_result(trace, Enum.reverse(metrics))

  defp verification_result({:error, failure, trace}),
    do: failed_result("revision_order_or_convergence", failure, trace)

  defp replay_events(events, session_id) do
    events
    |> Enum.reduce_while({:ok, Replica.new(), []}, fn event, {:ok, replica, frames} ->
      frame = event |> ProtocolV2.event() |> JSON.decode!()

      case Replica.apply_event(replica, frame) do
        {:ok, next} ->
          {:cont,
           {:ok, next,
            [%{"kind" => "event", "session_id" => session_id, "frame" => frame} | frames]}}

        {:error, reason} ->
          {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, replica, frames} -> {:ok, replica, Enum.reverse(frames)}
      error -> error
    end
  end

  defp converge_replicas(config, adapter, session, replay, expected) do
    replica_count = config.sockets * config.subscriptions

    Enum.reduce_while(1..replica_count, :ok, fn replica_index, :ok ->
      {cursor, local_replica} = recovery_cursor(config, replay, replica_index)
      maybe_wait_for_client_read(config.client_read_delay_ms)

      with {:ok, recovery} <- recover(adapter, session, cursor),
           {:ok, events} <- recovery_events(adapter, session, recovery),
           recovery = %{recovery | events: events},
           {:ok, replica} <- replica_from_recovery(recovery, local_replica, expected),
           :ok <- match_head(replica, recovery.head),
           true <- Replica.snapshot(replica) == Replica.snapshot(expected) do
        {:cont, :ok}
      else
        false -> {:halt, {:error, :replica_diverged}}
        {:error, reason} -> {:halt, {:error, reason}}
        reason -> {:halt, {:error, reason}}
      end
    end)
  end

  defp recovery_cursor(%{recovery_mode: :snapshot}, _replay, _index), do: {nil, Replica.new()}

  defp recovery_cursor(%{recovery_mode: :replay}, _replay, _index),
    do: {cursor(Replica.new()), Replica.new()}

  defp recovery_cursor(%{cursor_age: cursor_age} = config, replay, replica_index) do
    if config.network_interrupt_every > 0 and
         rem(replica_index, config.network_interrupt_every) == 0 do
      {cursor(Replica.new()), Replica.new()}
    else
      recovery_cursor_for_age(cursor_age, replay)
    end
  end

  defp recovery_cursor_for_age(cursor_age, replay) do
    target_revision = max(replay.head.revision - cursor_age, 0)

    replica =
      replay.events
      |> Enum.take(target_revision)
      |> Enum.map(&(&1 |> ProtocolV2.event() |> JSON.decode!()))
      |> Replica.replay()
      |> then(fn {:ok, state} -> state end)

    {cursor(replica), replica}
  end

  defp replica_from_recovery(%{mode: :snapshot, snapshot: snapshot}, _local_replica, _expected),
    do: Replica.from_snapshot(snapshot)

  defp replica_from_recovery(%{mode: :up_to_date}, _local_replica, expected), do: {:ok, expected}

  defp replica_from_recovery(%{mode: :replay, events: events}, local_replica, _expected),
    do: replay_events_from_cursor(events, local_replica)

  defp replica_from_recovery(_recovery, _local_replica, _expected),
    do: {:error, :unexpected_recovery_mode}

  defp replay_events_from_cursor(events, local_replica) do
    events
    |> Enum.map(&(&1 |> ProtocolV2.event() |> JSON.decode!()))
    |> then(&Replica.replay(local_replica, &1))
  end

  defp recover(:memory, session, cursor), do: Memory.recover_session(session, cursor)
  defp recover(:postgres, session, cursor), do: Postgres.recover_session(session, cursor)

  defp recovery_events(_adapter, _session, %{mode: mode}) when mode != :replay, do: {:ok, []}

  defp recovery_events(adapter, session, recovery) do
    fetch_recovery_events(adapter, session, recovery.replay_cursor, recovery.head.revision, [])
  end

  defp fetch_recovery_events(_adapter, _session, revision, revision, pages),
    do: {:ok, pages |> Enum.reverse() |> List.flatten()}

  defp fetch_recovery_events(adapter, session, cursor, head_revision, pages) do
    case recovery_page(adapter, session, cursor, head_revision) do
      {:ok, [_ | _] = events} ->
        fetch_recovery_events(
          adapter,
          session,
          List.last(events).revision,
          head_revision,
          [events | pages]
        )

      {:ok, []} ->
        {:error, :revision_gap}

      error ->
        error
    end
  end

  defp recovery_page(:memory, session, cursor, head_revision),
    do: Memory.recovery_page(session, cursor, head_revision)

  defp recovery_page(:postgres, session, cursor, head_revision),
    do: Postgres.recovery_page(session, cursor, head_revision)

  defp match_head(replica, head),
    do:
      if(replica.revision == head.revision and Replica.digest(replica) == head.digest,
        do: :ok,
        else: {:error, :head_mismatch}
      )

  defp match_snapshot(replica, snapshot),
    do: if(Replica.snapshot(replica) == snapshot, do: :ok, else: {:error, :snapshot_mismatch})

  defp cursor(replica),
    do: %{revision: replica.revision, state_schema_version: 1, digest: Replica.digest(replica)}

  defp maybe_wait_for_client_read(0), do: :ok
  defp maybe_wait_for_client_read(delay_ms), do: Process.sleep(delay_ms)

  defp passed_result(trace, metrics) do
    %{
      verdict: "PASS",
      invariants:
        Enum.map(
          ["exact_revision_order", "stable_idempotency", "replica_convergence"],
          &pass_invariant/1
        ),
      error: nil,
      trace: trace,
      metrics: %{"sessions" => metrics, "trace_records" => length(trace)}
    }
  end

  defp pass_invariant(name), do: %{"name" => name, "status" => "PASS", "detail" => "verified"}
  defp fail_invariant(name, detail), do: %{"name" => name, "status" => "FAIL", "detail" => detail}
end
