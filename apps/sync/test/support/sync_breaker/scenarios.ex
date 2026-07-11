defmodule ChalkSync.SyncBreaker.Scenarios do
  @moduledoc false

  alias ChalkSync.DevTools
  alias ChalkSync.Rooms.Room
  alias ChalkSync.Rooms.RoomServer
  alias ChalkSync.SyncBreaker.Model
  alias ChalkSync.SyncBreaker.Result
  alias ChalkSync.SyncBreaker.WireActor
  alias ChalkSync.TestWSClient

  @timeout 2_000

  def idempotency_retry_after_writer_restart(port) do
    with_room(
      "idempotency_retry_after_writer_restart",
      "idempotency-restart",
      &run_idempotency_retry(&1, port)
    )
  end

  defp run_idempotency_retry(room_id, port) do
    actor = WireActor.new("tenant-a", room_id, "participant-a", "Ada")
    trace = [hello_trace("writer-a", nil)]

    with {:ok, actor, _welcome} <- WireActor.connect(actor, port),
         {:ok, actor, original_ack, trace, seen} <- commit_original(actor, trace),
         {:ok, actor, restart, trace} <- restart_connected_writer(actor, trace),
         {:ok, _actor, retry_ack, trace} <-
           retry_after_restart(actor, port, original_ack, trace, seen) do
      original_revision = original_ack["revision"]

      evidence = %{
        "room_id" => room_id,
        "original_ack" => original_ack,
        "retry_ack" => retry_ack,
        "restart" => restart
      }

      case retry_ack do
        %{"result" => "duplicate", "revision" => ^original_revision} ->
          Result.pass("idempotency_retry_after_writer_restart",
            invariant: :idempotency,
            message: "retry reused the original committed revision after writer restart",
            evidence: evidence,
            trace: trace
          )

        _ ->
          Result.fail(
            "idempotency_retry_after_writer_restart",
            :idempotency,
            "retry after writer restart did not return duplicate for the original revision",
            evidence: evidence,
            trace: trace
          )
      end
    else
      {:error, reason, trace} ->
        Result.fail(
          "idempotency_retry_after_writer_restart",
          :idempotency,
          "writer-restart retry scenario could not observe its required wire transition",
          evidence: %{"reason" => trace_value(reason), "room_id" => room_id},
          trace: trace
        )

      {:error, reason} ->
        Result.fail(
          "idempotency_retry_after_writer_restart",
          :idempotency,
          "initial wire handshake failed",
          evidence: %{"reason" => trace_value(reason), "room_id" => room_id},
          trace: trace
        )
    end
  end

  def reconnect_replay_convergence(port) do
    with_room(
      "reconnect_replay_convergence",
      "reconnect-replay",
      &run_reconnect_replay(&1, port)
    )
  end

  defp run_reconnect_replay(room_id, port) do
    actor = WireActor.new("tenant-a", room_id, "participant-a", "Ada")
    trace = [hello_trace("original", nil)]

    with {:ok, actor, _welcome} <- WireActor.connect(actor, port),
         {:ok, actor, original_ack, trace, seen} <- commit_original(actor, trace),
         {:ok, actor, disconnect, trace} <- abruptly_disconnect(actor, trace),
         {:ok, actor, replay_welcome, trace, _seen} <-
           reconnect_actor(actor, port, trace, seen),
         {:ok, verifier, snapshot_welcome, trace} <- snapshot_verifier(room_id, port, trace) do
      model_snapshot = Model.snapshot(actor.model)
      authoritative_snapshot = Model.snapshot(verifier.model)
      replay_revision = replay_welcome["control_revision"]

      evidence = %{
        "room_id" => room_id,
        "original_ack" => original_ack,
        "disconnect" => disconnect,
        "replay_welcome" => replay_welcome,
        "model_snapshot" => model_snapshot,
        "authoritative_snapshot" => authoritative_snapshot,
        "snapshot_welcome" => snapshot_welcome
      }

      if replay_welcome["mode"] == "replay" and WireActor.revision(actor) == replay_revision and
           model_snapshot == authoritative_snapshot do
        Result.pass("reconnect_replay_convergence",
          invariant: :replay_convergence,
          message: "abrupt TCP loss converged through an exact replay",
          evidence: evidence,
          trace: trace
        )
      else
        Result.fail(
          "reconnect_replay_convergence",
          :replay_convergence,
          "reconnect replay did not reconstruct the authoritative snapshot",
          evidence: evidence,
          trace: trace
        )
      end
    else
      {:error, reason, trace} ->
        Result.fail(
          "reconnect_replay_convergence",
          :replay_convergence,
          "abrupt TCP loss scenario could not observe its required wire transition",
          evidence: %{"reason" => trace_value(reason), "room_id" => room_id},
          trace: trace
        )

      {:error, reason} ->
        Result.fail(
          "reconnect_replay_convergence",
          :replay_convergence,
          "initial wire handshake failed",
          evidence: %{"reason" => trace_value(reason), "room_id" => room_id},
          trace: trace
        )
    end
  end

  def replay_revision_jump_probe(apply_event \\ &Room.apply_event/2) do
    safely("replay_revision_jump_probe", fn ->
      room = Room.new("revision-jump-probe")

      event = %{
        name: "participant_joined",
        base_revision: 0,
        revision: 5,
        payload: %{"participant_id" => "participant-a", "display_name" => "Ada"}
      }

      trace = [
        trace_entry("room-core", "direct", %{"operation" => "apply_event", "event" => event})
      ]

      result = apply_event.(room, event)
      evidence = %{"event" => trace_value(event), "result" => trace_value(result)}

      case result do
        {:error, :revision_gap} ->
          Result.pass("replay_revision_jump_probe",
            invariant: :revision_continuity,
            message: "room core explicitly rejected the non-contiguous replay event",
            evidence: evidence,
            trace: trace
          )

        _ ->
          Result.fail(
            "replay_revision_jump_probe",
            :revision_continuity,
            "room core did not explicitly reject a non-contiguous replay event",
            evidence: evidence,
            trace: trace
          )
      end
    end)
  end

  defp commit_original(actor, trace) do
    {trace, seen} = append_actor_frames(trace, "writer-a", actor, 0)
    actor = WireActor.send_command(actor, "command-1", :raise_hand)
    trace = trace ++ [trace_entry("writer-a", "client_to_server", command("command-1"))]

    case WireActor.await_ack(actor, "command-1") do
      {:ok, actor, %{"result" => "committed", "revision" => revision} = ack} ->
        {trace, seen} = append_actor_frames(trace, "writer-a", actor, seen)

        case await_actor_revision(actor, revision) do
          {:ok, actor, frames} ->
            {:ok, actor, ack, trace ++ actor_frames("writer-a", frames), seen + length(frames)}

          {:error, reason, frames} ->
            {:error, reason, trace ++ actor_frames("writer-a", frames)}
        end

      {:ok, actor, ack} ->
        {trace, _seen} = append_actor_frames(trace, "writer-a", actor, seen)
        {:error, {:unexpected_original_ack, ack}, trace}

      {:error, reason} ->
        {:error, reason, trace}
    end
  end

  defp restart_connected_writer(actor, trace) do
    case RoomServer.whereis(actor.room_id) do
      pid when is_pid(pid) ->
        restart_writer(actor, trace, pid)

      nil ->
        {:error, :writer_not_found, trace}
    end
  end

  defp restart_writer(actor, trace, pid) do
    ref = Process.monitor(pid)

    with :ok <- DevTools.restart_room(actor.room_id),
         {:ok, reason} <- await_down(ref, pid),
         {:ok, code, close_reason, client, frames} <- await_close(actor.client, "writer-a") do
      restart_result(actor, trace ++ frames, client, reason, code, close_reason)
    else
      {:error, reason} -> {:error, reason, trace}
    end
  end

  defp restart_result(actor, trace, client, reason, 1012, close_reason) do
    restart = %{
      "writer_exit" => trace_value(reason),
      "close_code" => 1012,
      "close_reason" => close_reason
    }

    {:ok, %{actor | client: client, connected: false}, restart, trace}
  end

  defp restart_result(_actor, trace, _client, _reason, code, close_reason),
    do: {:error, {:unexpected_restart_close, code, close_reason}, trace}

  defp retry_after_restart(actor, port, original_ack, trace, seen) do
    cursor = original_ack["revision"]
    trace = trace ++ [hello_trace("writer-a-retry", cursor)]

    with {:ok, actor, _welcome} <- WireActor.connect(actor, port, cursor),
         actor <- WireActor.send_command(actor, "command-1", :raise_hand),
         trace <-
           trace ++ [trace_entry("writer-a-retry", "client_to_server", command("command-1"))],
         {:ok, actor, retry_ack} <- WireActor.await_ack(actor, "command-1") do
      {trace, _seen} = append_actor_frames(trace, "writer-a-retry", actor, seen)
      {:ok, actor, retry_ack, trace}
    else
      {:error, reason} -> {:error, reason, trace}
    end
  end

  defp abruptly_disconnect(actor, trace) do
    case RoomServer.whereis(actor.room_id) do
      pid when is_pid(pid) ->
        ref = Process.monitor(pid)
        actor = WireActor.close_tcp(actor)

        trace =
          trace ++ [trace_entry("original", "client_to_server", %{"operation" => "tcp_close"})]

        case await_down(ref, pid) do
          {:ok, reason} -> {:ok, actor, %{"writer_exit" => trace_value(reason)}, trace}
          {:error, reason} -> {:error, reason, trace}
        end

      nil ->
        {:error, :writer_not_found, trace}
    end
  end

  defp reconnect_actor(actor, port, trace, seen) do
    cursor = WireActor.revision(actor)
    trace = trace ++ [hello_trace("reconnected", cursor)]

    case WireActor.connect(actor, port, cursor) do
      {:ok, actor, welcome} ->
        {trace, seen} = append_actor_frames(trace, "reconnected", actor, seen)
        {:ok, actor, welcome, trace, seen}

      {:error, reason} ->
        {:error, reason, trace}
    end
  end

  defp snapshot_verifier(room_id, port, trace) do
    verifier = WireActor.new("tenant-a", room_id, "participant-a", "Ada")
    trace = trace ++ [hello_trace("snapshot-verifier", nil)]

    case WireActor.connect(verifier, port) do
      {:ok, verifier, welcome} ->
        {trace, _seen} = append_actor_frames(trace, "snapshot-verifier", verifier, 0)
        {:ok, verifier, welcome, trace}

      {:error, reason} ->
        {:error, reason, trace}
    end
  end

  defp await_actor_revision(actor, target) do
    if WireActor.revision(actor) == target do
      {:ok, actor, []}
    else
      deadline = System.monotonic_time(:millisecond) + @timeout
      await_actor_revision(actor, target, deadline, [])
    end
  end

  defp await_actor_revision(actor, target, deadline, frames) do
    timeout = max(deadline - System.monotonic_time(:millisecond), 0)

    case TestWSClient.recv(actor.client, timeout) do
      {:json, %{"type" => "event"} = event, client} ->
        advance_actor_revision(actor, event, client, target, deadline, frames)

      {:json, frame, client} ->
        actor = %{actor | client: client, frames: actor.frames ++ [frame]}
        await_actor_revision(actor, target, deadline, frames ++ [frame])

      {:closed, code, reason, _client} ->
        {:error, {:closed, code, reason}, frames}

      {:error, reason} ->
        {:error, reason, frames}

      other ->
        {:error, other, frames}
    end
  end

  defp advance_actor_revision(actor, event, client, target, deadline, frames) do
    case Model.apply_event(actor.model, event) do
      {:ok, model} ->
        actor = %{actor | client: client, model: model, frames: actor.frames ++ [event]}

        if model.revision == target,
          do: {:ok, actor, frames ++ [event]},
          else: await_actor_revision(actor, target, deadline, frames ++ [event])

      {:error, reason} ->
        {:error, {:replica, reason, event}, frames ++ [event]}
    end
  end

  defp await_down(ref, pid) do
    receive do
      {:DOWN, ^ref, :process, ^pid, reason} -> {:ok, reason}
    after
      @timeout -> {:error, :writer_down_timeout}
    end
  end

  defp await_close(client, connection) do
    case TestWSClient.recv(client, @timeout) do
      {:closed, code, reason, client} ->
        {:ok, code, reason, client,
         [trace_entry(connection, "server_to_client", {:close, code, reason})]}

      {:json, frame, client} ->
        {:error, {:unexpected_open_frame, frame, client}}

      {:text, text, client} ->
        {:error, {:unexpected_open_frame, text, client}}

      {:binary, data, client} ->
        {:error, {:unexpected_open_frame, data, client}}

      {:error, reason} ->
        {:error, reason}

      other ->
        {:error, other}
    end
  end

  defp append_actor_frames(trace, connection, actor, seen) do
    frames = Enum.drop(actor.frames, seen)
    {trace ++ actor_frames(connection, frames), seen + length(frames)}
  end

  defp actor_frames(connection, frames),
    do: Enum.map(frames, &trace_entry(connection, "server_to_client", &1))

  defp hello_trace(connection, cursor) do
    frame = %{"type" => "hello", "protocol" => 1, "token" => "[redacted]"}

    frame =
      if is_integer(cursor),
        do: Map.put(frame, "streams", %{"control" => %{"cursor" => cursor}}),
        else: frame

    trace_entry(connection, "client_to_server", frame)
  end

  defp command(command_id),
    do: %{
      "type" => "command",
      "command_id" => command_id,
      "name" => "raise_hand",
      "payload" => %{}
    }

  defp trace_entry(connection, direction, frame) do
    %{"connection" => connection, "direction" => direction, "frame" => trace_value(frame)}
  end

  defp trace_value(%Room{} = room), do: %{"room" => Room.snapshot(room)}

  defp trace_value(map) when is_map(map) do
    Map.new(map, fn {key, value} ->
      key = to_string(key)
      {key, if(key == "token", do: "[redacted]", else: trace_value(value))}
    end)
  end

  defp trace_value(list) when is_list(list), do: Enum.map(list, &trace_value/1)

  defp trace_value({:close, code, reason}),
    do: %{"opcode" => "close", "code" => code, "reason" => reason}

  defp trace_value(value) when is_boolean(value) or is_nil(value), do: value
  defp trace_value(value) when is_atom(value), do: Atom.to_string(value)
  defp trace_value(value), do: value

  defp unique_room_id(prefix), do: "#{prefix}-#{System.unique_integer([:positive, :monotonic])}"

  defp with_room(scenario, prefix, fun) do
    safely(scenario, fn ->
      room_id = unique_room_id(prefix)

      try do
        fun.(room_id)
      after
        cleanup_room(room_id, 50)
      end
    end)
  end

  defp cleanup_room(_room_id, 0), do: :ok

  defp cleanup_room(room_id, attempts) do
    case RoomServer.whereis(room_id) do
      nil ->
        :ok

      writer ->
        DynamicSupervisor.terminate_child(ChalkSync.Rooms.Supervisor, writer)

        receive do
        after
          1 -> cleanup_room(room_id, attempts - 1)
        end
    end
  end

  defp safely(scenario, fun) do
    fun.()
  rescue
    exception -> Result.error(scenario, exception, stacktrace: __STACKTRACE__)
  catch
    kind, value -> Result.error(scenario, RuntimeError.exception("#{kind}: #{inspect(value)}"))
  end
end
