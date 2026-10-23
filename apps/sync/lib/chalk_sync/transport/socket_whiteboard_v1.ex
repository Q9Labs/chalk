defmodule ChalkSync.Transport.SocketWhiteboardV1 do
  @moduledoc "Independent whiteboard-v1 WebSocket transport."
  @behaviour WebSock
  alias ChalkSync.Auth.Claims
  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketClose
  alias ChalkSync.Transport.SocketContext
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.Multipart
  alias ChalkSync.WhiteboardV1.OutboundQueue
  alias ChalkSync.WhiteboardV1.Protocol
  alias ChalkSync.WhiteboardV1.ViewOwner
  @hello_timeout_ms 5000
  @multipart_timeout_ms GeneratedWhiteboardV1.limits()["multipartUpdateTimeoutMs"]
  @max_pending_snapshots GeneratedWhiteboardV1.limits()["pendingOperationMaxItems"]
  @access_retry_ms 1_000
  @access_reconcile_ms 30_000
  @impl true
  def init(options) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)

    connection_attributes =
      options |> Map.new() |> Map.get(:connection_attributes, %{close_code: nil})

    observability =
      options
      |> Map.new()
      |> Map.get(:observability)
      |> Observability.merge(nil)
      |> Observability.root(
        "sync.websocket.handshake",
        Map.merge(connection_attributes, %{
          transport: "websocket",
          protocol: "whiteboard-v1"
        })
      )

    {:ok,
     %{
       phase: :awaiting_hello,
       hello_timer: timer,
       identity: nil,
       connected_at: nil,
       display_name: nil,
       presentation_negotiated: false,
       view_negotiated: false,
       view_origins_negotiated: false,
       draw_policy_negotiated: false,
       can_draw: nil,
       access: nil,
       access_timer: nil,
       access_stale: false,
       view_owner_negotiated: false,
       view_owner: nil,
       view_owner_ref: nil,
       scene_id: nil,
       revision: 0,
       snapshot: nil,
       pending_snapshot_requests: [],
       pending_bring: nil,
       pending_views: %{},
       awaiting_snapshot: false,
       missed_head: nil,
       multipart: nil,
       multipart_timer: nil,
       presence_windows: %{},
       outbound: OutboundQueue.new(),
       terminal: nil,
       connection_attributes: connection_attributes,
       observability: observability
     }}
  end

  @impl true
  def handle_in(payload, state) do
    with {:ok, state} <- current_authority(state), do: receive_payload(payload, state)
  end

  @impl true
  def handle_info(message, state) do
    with {:ok, state} <- current_authority(state), do: handle_message(message, state)
  end

  defp receive_payload({text, opcode: :text}, state) do
    case Protocol.decode(text) do
      {:ok, frame} -> handle_frame(frame, state)
      {:error, reason} -> stop(state, 1009, close_reason(reason), :protocol_error)
    end
  end

  defp receive_payload({_payload, _options}, state) do
    stop(state, 1009, "text frames only", :protocol_error)
  end

  # Fanout delivers to every subscribed socket, so a Participant who was removed or whose
  # Episode ended would keep receiving and sending live frames until it disconnected. An idle
  # board gets the same check from its tick.
  defp current_authority(%{identity: nil} = state), do: {:ok, state}

  defp current_authority(state) do
    case Authority.check(state.identity, state.connected_at) do
      :ok ->
        {:ok, state}

      {:error, {:permission_denied, denial}} ->
        {:stop, reason, close, state} =
          stop(state, 1008, "policy violation", :permission_denied)

        {:stop, reason, close, put_in(state.terminal[:denial], denial)}

      {:retryable, {_reason, failure}} ->
        dependency_unavailable(state, failure)
    end
  end

  # The close trace keeps a bounded failure category; the peer sees only that it may retry.
  defp dependency_unavailable(state, failure) do
    {:stop, reason, close, state} =
      stop(state, 1012, "dependency unavailable", :dependency_unavailable)

    {:stop, reason, close, put_in(state.terminal[:failure], failure)}
  end

  defp handle_message({:DOWN, ref, :process, _pid, _reason}, %{view_owner_ref: ref} = state) do
    stop(state, 1012, "view owner restarted", :view_owner_restarted)
  end

  defp handle_message(:whiteboard_authority_tick, state) do
    Process.send_after(self(), :whiteboard_authority_tick, Authority.poll_ms())
    {:ok, state}
  end

  defp handle_message(:hello_timeout, %{phase: :awaiting_hello} = state) do
    stop(state, 1008, "hello timeout", :hello_timeout)
  end

  defp handle_message(:hello_timeout, state) do
    {:ok, state}
  end

  defp handle_message(
         {:whiteboard_multipart_timeout, operation_id},
         %{multipart: %{operation_id: operation_id}} = state
       ) do
    state = %{state | multipart: nil, multipart_timer: nil}
    operation_failure(operation_id, :submit_update, {:retryable, :overloaded}, state)
  end

  defp handle_message({:whiteboard_multipart_timeout, _operation_id}, state) do
    {:ok, state}
  end

  defp handle_message(
         {:whiteboard_v1_frame, %{"type" => type, "participant_id" => participant_id}},
         %{identity: %Identity{participant_id: participant_id}} = state
       )
       when type == "cursor" do
    {:ok, state}
  end

  defp handle_message(
         {:whiteboard_v1_frame, %{"type" => "view", "participant_id" => participant_id}},
         %{
           identity: %Identity{participant_id: participant_id},
           view_owner_negotiated: false
         } = state
       ) do
    {:ok, state}
  end

  defp handle_message(
         {:whiteboard_v1_frame, %{"type" => "view"}},
         %{view_negotiated: false} = state
       ) do
    {:ok, state}
  end

  defp handle_message(
         {:whiteboard_v1_frame, %{"type" => "presentation_updated"}},
         %{phase: :live, presentation_negotiated: false} = state
       ) do
    {:ok, state}
  end

  defp handle_message(
         {:whiteboard_v1_frame,
          %{"type" => "presentation_updated", "scene_id" => scene_id, "revision" => revision} =
            frame},
         %{phase: :live, presentation_negotiated: true, scene_id: scene_id} = state
       ) do
    deliver_in_order(state, frame, scene_id, String.to_integer(revision))
  end

  defp handle_message(
         {:whiteboard_v1_frame, %{"type" => "presentation_updated"}},
         %{phase: :live} = state
       ) do
    {:ok, state}
  end

  defp handle_message(
         {:whiteboard_v1_frame,
          %{"type" => type, "scene_id" => scene_id, "revision" => revision} = frame},
         %{phase: :live, scene_id: scene_id} = state
       )
       when type in ["update", "update_part"] and is_binary(revision) do
    deliver_in_order(state, frame, scene_id, String.to_integer(revision))
  end

  defp handle_message(
         {:whiteboard_v1_frame, %{"type" => "view"} = frame},
         %{phase: :live} = state
       ) do
    deliver_frame(state, compatible_view(frame, state))
  end

  defp handle_message({:whiteboard_v1_frame, frame}, %{phase: :live} = state) do
    deliver_frame(state, frame)
  end

  defp handle_message(
         {:whiteboard_v1_frame, %{"type" => "view"} = frame},
         %{phase: :recovering} = state
       ) do
    bring = if frame["bring"], do: frame, else: state.pending_bring

    {:ok,
     %{
       state
       | pending_bring: bring,
         pending_views:
           Map.put(state.pending_views, frame["participant_id"], %{frame | "bring" => false})
     }}
  end

  defp handle_message(
         {:whiteboard_v1_frame, %{"scene_id" => scene_id, "revision" => revision}},
         %{phase: :recovering} = state
       )
       when is_binary(revision) do
    {:ok, note_missed_head(state, scene_id, String.to_integer(revision))}
  end

  defp handle_message({:whiteboard_v1_frame, _frame}, state) do
    {:ok, state}
  end

  defp handle_message(
         {:whiteboard_v1_head, scene_id, revision},
         %{phase: :live, identity: identity} = state
       ) do
    cond do
      scene_id != state.scene_id ->
        enqueue_and_push(
          %{state | scene_id: scene_id, revision: revision},
          [%{"type" => "reset_required", "scene_id" => scene_id, "reason" => "scene_changed"}]
        )

      revision <= state.revision ->
        {:ok, state}

      true ->
        replay_or_reset(state, identity, scene_id, revision)
    end
  end

  defp handle_message({:whiteboard_v1_head, scene_id, revision}, %{phase: :recovering} = state) do
    {:ok, note_missed_head(state, scene_id, revision)}
  end

  defp handle_message({:whiteboard_v1_head, _scene_id, _revision}, state) do
    {:ok, state}
  end

  defp handle_message(:whiteboard_v1_access_changed, %{phase: :live} = state) do
    refresh_access(state)
  end

  defp handle_message(:whiteboard_v1_access_changed, %{phase: :recovering} = state) do
    {:ok, %{state | access_stale: true}}
  end

  defp handle_message(:whiteboard_v1_access_changed, state) do
    {:ok, state}
  end

  defp handle_message(:whiteboard_drain, state) do
    push_next(state)
  end

  defp handle_message(
         :whiteboard_snapshot_next,
         %{
           phase: :live,
           terminal: nil,
           pending_snapshot_requests: [_ | _],
           outbound: %{frame_count: queued}
         } = state
       )
       when queued > 0 do
    send(self(), :whiteboard_snapshot_next)
    {:ok, state}
  end

  defp handle_message(:whiteboard_snapshot_next, %{terminal: terminal} = state)
       when not is_nil(terminal) do
    {:ok, state}
  end

  defp handle_message(
         :whiteboard_snapshot_next,
         %{phase: :live, pending_snapshot_requests: [request | remaining]} = state
       ) do
    result =
      handle_frame({:request_snapshot, request}, %{state | pending_snapshot_requests: remaining})

    case result do
      {:push, _frame, %{phase: :live} = next} -> resume_snapshot_requests(next)
      _recovering -> :ok
    end

    result
  end

  defp handle_message(:whiteboard_snapshot_next, state) do
    {:ok, state}
  end

  defp note_missed_head(%{missed_head: {scene_id, seen}} = state, scene_id, revision)
       when seen >= revision do
    state
  end

  defp note_missed_head(state, scene_id, revision) do
    %{state | missed_head: {scene_id, revision}}
  end

  defp resume_stale_access(%{access_stale: false} = state), do: state

  defp resume_stale_access(state) do
    send(self(), :whiteboard_v1_access_changed)
    %{state | access_stale: false}
  end

  # The server computes each person's drawing permission; a socket only
  # relays its own. Clients without draw_policy_v1 keep the legacy frame.
  # Notifications only speed this up: one timer per socket reads the answer
  # again, so a missed notification is repaired and an outage costs one retry.
  defp refresh_access(%{identity: identity} = state) do
    case Episode.draw_access(identity) do
      {:ok, access} ->
        state
        |> arm_access_timer(@access_reconcile_ms)
        |> Map.merge(%{can_draw: access["can_draw"], access: access})
        |> enqueue_and_push(access_frames(state, access))

      {:error, :permission_denied} ->
        {:ok, state}

      _unavailable ->
        {:ok, arm_access_timer(state, @access_retry_ms)}
    end
  end

  defp arm_access_timer(%{access_timer: timer} = state, delay) do
    if timer, do: Process.cancel_timer(timer)
    %{state | access_timer: Process.send_after(self(), :whiteboard_v1_access_changed, delay)}
  end

  defp access_frames(%{draw_policy_negotiated: true, access: access}, access), do: []
  defp access_frames(%{draw_policy_negotiated: true}, access), do: [access]
  defp access_frames(%{can_draw: can_draw}, %{"can_draw" => can_draw}), do: []

  defp access_frames(%{identity: identity}, access) do
    [
      %{
        "type" => "permission_updated",
        "participant_id" => identity.participant_id,
        "can_draw" => access["can_draw"]
      }
    ]
  end

  defp resume_pending_bring(state) do
    if state.pending_bring, do: send(self(), {:whiteboard_v1_frame, state.pending_bring})

    Enum.each(state.pending_views, fn {_person, frame} ->
      send(self(), {:whiteboard_v1_frame, frame})
    end)

    %{state | pending_bring: nil, pending_views: %{}}
  end

  defp catch_up_after_snapshot(state, nil) do
    {:ok, state}
  end

  defp catch_up_after_snapshot(state, {scene_id, revision}) do
    handle_message({:whiteboard_v1_head, scene_id, revision}, state)
  end

  defp deliver_in_order(state, frame, scene_id, revision) do
    cond do
      revision <= state.revision -> {:ok, state}
      revision == state.revision + 1 -> deliver_frame(state, frame)
      true -> replay_or_reset(state, state.identity, scene_id, revision)
    end
  end

  defp replay_or_reset(%{awaiting_snapshot: true} = state, _identity, _scene_id, _revision) do
    {:ok, state}
  end

  defp replay_or_reset(state, identity, scene_id, revision) do
    case Episode.read_after(
           identity,
           scene_id,
           state.revision,
           state.presentation_negotiated
         ) do
      {:ok, frames} ->
        reached = replayed_revision(frames)

        if replay_reaches_head?(state, reached, revision) do
          enqueue_replay(state, scene_id, reached, frames)
        else
          enqueue_gap_reset(state, scene_id)
        end

      _unavailable ->
        enqueue_gap_reset(state, scene_id)
    end
  end

  @impl true
  def terminate(reason, %{identity: %Identity{episode: episode}} = state) do
    Fanout.unsubscribe(episode)
    observe_terminal(state, reason)
    :ok
  end

  def terminate(reason, state) do
    observe_terminal(state, reason)
    :ok
  end

  defp handle_frame(
         {:hello, %{token: token, extensions: extensions}},
         %{phase: :awaiting_hello} = state
       ) do
    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, identity} <- identity(claims) do
      authenticated_hello(
        SocketContext.authenticated(state, identity),
        identity,
        claims,
        extensions
      )
    else
      {:error, _reason} -> stop(state, 1008, "invalid token", :invalid_token)
    end
  end

  defp handle_frame({:hello, _hello}, state) do
    stop(state, 1008, "already authenticated", :protocol_error)
  end

  defp handle_frame({:submit_update, operation}, %{phase: :live, identity: identity} = state) do
    if is_nil(state.multipart) do
      submit_update(identity, operation, state)
    else
      operation_failure(operation.operation_id, :submit_update, {:retryable, :overloaded}, state)
    end
  end

  defp handle_frame(
         {:submit_update_part, part},
         %{phase: :live, identity: identity} = state
       ) do
    case Multipart.add(state.multipart, part) do
      {:incomplete, assembly} ->
        timer =
          state.multipart_timer ||
            Process.send_after(
              self(),
              {:whiteboard_multipart_timeout, part.operation_id},
              @multipart_timeout_ms
            )

        {:ok, %{state | multipart: assembly, multipart_timer: timer}}

      {:complete, operation} ->
        cancel_timer(state.multipart_timer)
        submit_update(identity, operation, %{state | multipart: nil, multipart_timer: nil})

      failure ->
        cancel_timer(state.multipart_timer)

        operation_failure(
          part.operation_id,
          :submit_update,
          failure,
          %{state | multipart: nil, multipart_timer: nil}
        )
    end
  end

  defp handle_frame({:clear, operation}, %{phase: :live, identity: identity} = state) do
    case Episode.clear(identity, operation) do
      {:ok, commit, reset} ->
        Fanout.broadcast_local(identity.episode, reset)
        state = observe_operation(state, "clear", "committed")
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :clear, failure, state)
    end
  end

  defp handle_frame(
         {:set_draw_permission, operation},
         %{phase: :live, identity: identity} = state
       ) do
    case Episode.set_draw_permission(identity, operation) do
      {:ok, commit} ->
        state = observe_operation(state, "set_draw_permission", "committed")
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :set_draw_permission, failure, state)
    end
  end

  defp handle_frame(
         {:set_draw_policy, operation},
         %{phase: :live, draw_policy_negotiated: false} = state
       ) do
    operation_failure(operation.operation_id, :set_draw_policy, {:error, :unavailable}, state)
  end

  defp handle_frame({:set_draw_policy, operation}, %{phase: :live, identity: identity} = state) do
    case Episode.set_draw_policy(identity, operation) do
      {:ok, commit} ->
        state = observe_operation(state, "set_draw_policy", "committed")
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :set_draw_policy, failure, state)
    end
  end

  defp handle_frame(
         {:set_presentation, operation},
         %{phase: :live, presentation_negotiated: false} = state
       ) do
    operation_failure(operation.operation_id, :set_presentation, {:error, :unavailable}, state)
  end

  defp handle_frame(
         {:set_presentation, operation},
         %{phase: :live, identity: identity} = state
       ) do
    case Episode.set_presentation(identity, operation) do
      {:ok, commit, presentation} ->
        Fanout.broadcast_local(identity.episode, presentation)
        state = observe_operation(state, "set_presentation", "committed")
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :set_presentation, failure, state)
    end
  end

  defp handle_frame(
         {:request_snapshot, request},
         %{phase: :recovering, snapshot: snapshot, pending_snapshot_requests: pending} = state
       ) do
    cond do
      request.request_id == snapshot.request_id or request in pending ->
        {:ok, state}

      length(pending) < @max_pending_snapshots ->
        {:ok, %{state | pending_snapshot_requests: pending ++ [request]}}

      true ->
        operation_failure(request.request_id, :request_snapshot, {:retryable, :overloaded}, state)
    end
  end

  defp handle_frame({type, _frame}, %{phase: :recovering} = state)
       when type in [:cursor, :view] do
    {:ok, state}
  end

  defp handle_frame({operation, frame}, %{phase: :recovering} = state)
       when operation in [
              :submit_update,
              :submit_update_part,
              :clear,
              :set_draw_permission,
              :set_draw_policy,
              :set_presentation
            ] do
    operation =
      if operation == :submit_update_part do
        :submit_update
      else
        operation
      end

    operation_failure(frame.operation_id, operation, {:retryable, :overloaded}, state)
  end

  defp handle_frame(
         {:request_snapshot, %{request_id: request_id}},
         %{phase: :live, identity: identity} = state
       ) do
    state = %{
      state
      | pending_snapshot_requests:
          Enum.reject(state.pending_snapshot_requests, &(&1.request_id == request_id))
    }

    case Episode.snapshot(identity, request_id) do
      {:ok, [first | remaining]} ->
        snapshot = %{
          request_id: request_id,
          scene_id: first["scene_id"],
          revision: first["revision"],
          acknowledged_page: -1,
          remaining: remaining
        }

        next =
          %{state | phase: :recovering, snapshot: snapshot, awaiting_snapshot: false}
          |> observe_operation("request_snapshot", "accepted")

        nil
        {:push, {:text, Protocol.encode!(first)}, next}

      failure ->
        operation_failure(
          request_id,
          :request_snapshot,
          failure,
          %{state | awaiting_snapshot: false}
        )
    end
  end

  defp handle_frame(
         {:snapshot_ack, acknowledgement},
         %{phase: :recovering, snapshot: snapshot} = state
       ) do
    expected_page = snapshot.acknowledged_page + 1

    if acknowledgement.request_id == snapshot.request_id and
         acknowledgement.scene_id == snapshot.scene_id and
         acknowledgement.revision == snapshot.revision and acknowledgement.page == expected_page do
      case snapshot.remaining do
        [next | remaining] ->
          next_snapshot = %{snapshot | acknowledged_page: expected_page, remaining: remaining}
          {:push, {:text, Protocol.encode!(next)}, %{state | snapshot: next_snapshot}}

        [] ->
          next = %{
            state
            | phase: :live,
              snapshot: nil,
              scene_id: snapshot.scene_id,
              revision: String.to_integer(snapshot.revision),
              missed_head: nil
          }

          next = next |> resume_pending_bring() |> resume_stale_access()
          resume_snapshot_requests(next)
          catch_up_after_snapshot(next, state.missed_head)
      end
    else
      stop(state, 1008, "invalid snapshot acknowledgement", :invalid_acknowledgement)
    end
  end

  defp handle_frame(
         {:cursor, cursor},
         %{phase: :live, identity: identity, display_name: display_name} = state
       ) do
    {admission, next} = admit_presence(state, :cursor)

    with :ok <- admission do
      frame = %{
        "type" => "cursor",
        "participant_id" => identity.participant_id,
        "display_name" => display_name,
        "x" => cursor.x,
        "y" => cursor.y,
        "occurred_at" =>
          DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
      }

      Fanout.publish_cursor(identity.episode, frame)
    end

    {:ok, next}
  end

  defp handle_frame({:view, _view}, %{phase: :live, view_negotiated: false} = state) do
    {:ok, state}
  end

  defp handle_frame(
         {:view, view},
         %{phase: :live, identity: identity, display_name: display_name} = state
       ) do
    {admission, next} = admit_presence(state, if(view.bring, do: :bring, else: :view))

    case admit_view(view, identity, admission) do
      :ok ->
        frame = %{
          "type" => "view",
          "participant_id" => identity.participant_id,
          "display_name" => display_name,
          "x" => view.x,
          "y" => view.y,
          "width" => view.width,
          "height" => view.height,
          "bring" => view.bring,
          "occurred_at" =>
            DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
        }

        case ViewOwner.move(state.view_owner, frame, view) do
          :ok -> acknowledge_view(view, next)
          {:error, :overloaded} -> stop(next, 1013, "view capacity exhausted", :overloaded)
        end

      _denied ->
        {:ok, next}
    end
  end

  defp handle_frame({:ping, _ping}, state) do
    {:push, {:text, Protocol.pong()}, state}
  end

  defp handle_frame(_frame, state) do
    stop(state, 1008, "operation not available in this phase", :protocol_error)
  end

  defp acknowledge_view(%{input_id: id}, %{view_owner_negotiated: true} = state),
    do: {:push, {:text, Protocol.encode!(%{"type" => "view_ack", "input_id" => id})}, state}

  defp acknowledge_view(_view, state), do: {:ok, state}

  defp compatible_view(frame, %{view_owner_negotiated: true}), do: frame

  defp compatible_view(frame, %{view_origins_negotiated: true}) do
    frame
    |> Map.drop(["owner_id", "owner_sequence"])
    |> Map.merge(%{
      "origin_participant_id" => frame["participant_id"],
      "origin_sequence" => frame["owner_sequence"],
      "origin_epoch" => frame["owner_id"]
    })
  end

  defp compatible_view(frame, _state),
    do: Map.drop(frame, ["owner_id", "owner_sequence"])

  defp admit_view(_view, _identity, {:error, reason}), do: {:error, reason}

  defp admit_view(view, identity, :ok) do
    if authorized_view?(view, identity), do: :ok, else: {:error, :unauthorized}
  end

  defp authorized_view?(%{bring: false}, _identity), do: true

  defp authorized_view?(_bring, identity) do
    case Episode.connect(identity) do
      {:ok, %{"capabilities" => capabilities}} -> "manageWhiteboard" in capabilities
      _unavailable -> false
    end
  end

  defp submit_update(identity, operation, state) do
    case Episode.submit_update(identity, operation) do
      {:ok, commit, updates} ->
        Enum.each(updates, &Fanout.broadcast_local(identity.episode, &1))
        state = observe_operation(state, "submit_update", "committed")
        state = acknowledge_contiguous_commit(state, commit)
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :submit_update, failure, state)
    end
  end

  defp acknowledge_contiguous_commit(state, commit) do
    if commit["scene_id"] == state.scene_id and
         String.to_integer(commit["revision"]) == state.revision + 1 do
      advance_cursor(state, commit)
    else
      state
    end
  end

  defp operation_failure(correlation_id, operation, failure, state) do
    {reason, recoverable} =
      case failure do
        {:error, reason} -> {reason, false}
        {:retryable, reason} -> {reason, true}
        _ -> {:unavailable, true}
      end

    code = normalize_error(reason)

    state = observe_operation(state, operation, Atom.to_string(code))

    {:push,
     {:text,
      Protocol.operation_error(
        correlation_id,
        operation,
        code,
        recoverable,
        error_message(reason, code)
      )}, state}
  end

  defp enqueue_and_push(state, frames) do
    case enqueue_frames(state.outbound, frames) do
      {:ok, queue} ->
        push_next(%{state | outbound: queue})

      {:error, _reason} ->
        stop(state, 1012, "whiteboard delivery recovery required", :delivery_unavailable)
    end
  end

  defp deliver_frame(state, frame) do
    next = advance_cursor(state, frame)
    enqueue_and_push(next, [frame])
  end

  defp push_next(state) do
    case OutboundQueue.pop(state.outbound, System.monotonic_time(:millisecond)) do
      {:ok, frame, queue} ->
        if queue.frame_count > 0 do
          send(self(), :whiteboard_drain)
        end

        {:push, {:text, Protocol.encode!(frame)}, %{state | outbound: queue}}

      :empty ->
        {:ok, state}

      {:error, _reason} ->
        stop(state, 1012, "whiteboard delivery recovery required", :delivery_unavailable)
    end
  end

  defp advance_cursor(state, %{"type" => type, "scene_id" => scene_id, "revision" => revision})
       when type in ["update", "commit", "presentation_updated"] do
    %{state | scene_id: scene_id, revision: String.to_integer(revision)}
  end

  defp advance_cursor(state, %{
         "type" => "update_part",
         "scene_id" => scene_id,
         "revision" => revision,
         "part" => part,
         "part_count" => part_count
       })
       when part == part_count - 1 do
    %{state | scene_id: scene_id, revision: String.to_integer(revision)}
  end

  defp advance_cursor(state, %{
         "type" => "reset_required",
         "scene_id" => scene_id,
         "reason" => "scene_changed"
       }) do
    %{state | scene_id: scene_id, revision: 0}
  end

  defp advance_cursor(state, _frame) do
    state
  end

  defp identity(
         %Claims{
           tenant_id: tenant_id,
           space_id: space_id,
           episode_id: episode_id,
           participant_id: participant_id,
           participant_generation: generation
         } = claims
       )
       when is_binary(tenant_id) and is_binary(space_id) and is_binary(episode_id) and
              is_binary(participant_id) and is_integer(generation) and generation > 0 do
    {:ok,
     %Identity{
       episode: %EpisodeKey{tenant_id: tenant_id, space_id: space_id, episode_id: episode_id},
       participant_id: participant_id,
       participant_generation: generation,
       admission_lifecycle_intent_id: claims.admission_lifecycle_intent_id,
       role: claims.role,
       capabilities: claims.capabilities
     }}
  end

  defp identity(_claims) do
    {:error, :invalid_identity}
  end

  defp normalize_error(code)
       when code in [
              :permission_denied,
              :invalid_payload,
              :stale_scene,
              :cursor_reset_required,
              :rate_limited,
              :overloaded,
              :storage_unavailable
            ] do
    code
  end

  defp normalize_error(:draw_policy_limit) do
    :rate_limited
  end

  defp normalize_error(_code) do
    :unavailable
  end

  defp error_message(:draw_policy_limit, _code) do
    "This Episode has reached its limit of drawing policy changes"
  end

  defp error_message(_reason, code) do
    error_message(code)
  end

  defp error_message(:permission_denied) do
    "Whiteboard permission denied"
  end

  defp error_message(:invalid_payload) do
    "Invalid whiteboard payload"
  end

  defp error_message(:stale_scene) do
    "Whiteboard scene changed"
  end

  defp error_message(:cursor_reset_required) do
    "Whiteboard snapshot required"
  end

  defp error_message(:rate_limited) do
    "Whiteboard cursor rate exceeded"
  end

  defp error_message(:overloaded) do
    "Whiteboard temporarily overloaded"
  end

  defp error_message(:storage_unavailable) do
    "Whiteboard storage unavailable"
  end

  defp error_message(:unavailable) do
    "Whiteboard unavailable"
  end

  defp close_reason(:frame_too_large) do
    "frame too large"
  end

  defp close_reason(:invalid_json) do
    "invalid JSON"
  end

  defp close_reason(_reason) do
    "invalid whiteboard frame"
  end

  defp admit_presence(state, kind) do
    now_ms = System.monotonic_time(:millisecond)
    limit = Map.fetch!(%{bring: 2, cursor: 60, view: 10}, kind)
    {started, count} = Map.get(state.presence_windows, kind, {now_ms, 0})
    {started, count} = if now_ms - started >= 1000, do: {now_ms, 0}, else: {started, count}

    if count < limit do
      {:ok,
       %{state | presence_windows: Map.put(state.presence_windows, kind, {started, count + 1})}}
    else
      {{:error, :rate_limited}, state}
    end
  end

  defp replay_reaches_head?(%{presentation_negotiated: true}, reached, revision) do
    reached >= revision
  end

  defp replay_reaches_head?(_legacy, reached, revision) do
    reached == revision
  end

  defp replayed_revision([]) do
    0
  end

  defp replayed_revision(frames) do
    frames |> List.last() |> Map.fetch!("revision") |> String.to_integer()
  end

  defp cancel_timer(nil) do
    :ok
  end

  defp cancel_timer(timer) do
    Process.cancel_timer(timer)
  end

  defp resume_snapshot_requests(%{pending_snapshot_requests: []}) do
    :ok
  end

  defp resume_snapshot_requests(_state) do
    send(self(), :whiteboard_snapshot_next)
  end

  defp enqueue_gap_reset(state, scene_id) do
    enqueue_and_push(%{state | awaiting_snapshot: true}, [
      %{"type" => "reset_required", "scene_id" => scene_id, "reason" => "gap"}
    ])
  end

  defp enqueue_replay(state, scene_id, revision, frames) do
    case enqueue_frames(state.outbound, frames) do
      {:ok, queue} -> push_next(%{state | outbound: queue, revision: revision})
      {:error, _reason} -> enqueue_gap_reset(state, scene_id)
    end
  end

  defp enqueue_frames(queue, frames) do
    now_ms = System.monotonic_time(:millisecond)

    Enum.reduce_while(frames, {:ok, queue}, fn frame, {:ok, current} ->
      case OutboundQueue.push(current, frame, now_ms) do
        {:ok, next} -> {:cont, {:ok, next}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp observe_operation(state, operation, outcome) do
    observability =
      Observability.phase(state.observability, "sync.whiteboard", %{
        operation: to_string(operation),
        outcome: outcome
      })

    %{state | observability: observability}
  end

  defp stop(state, close_code, message, reason) do
    terminal = %{close_code: close_code, reason: reason}
    {:stop, :normal, {close_code, message}, %{state | terminal: terminal}}
  end

  defp observe_terminal(state, terminate_reason) do
    Observability.terminal(
      state.observability,
      "sync.websocket.closed",
      state.connection_attributes
      |> Map.merge(SocketClose.attributes(terminate_reason, state.terminal))
      |> Map.merge(%{protocol: "whiteboard-v1", phase: state.phase})
      |> put_scene_id(state.scene_id)
    )
  end

  defp put_scene_id(attributes, scene_id) when is_binary(scene_id) do
    Map.put(attributes, :scene_id, scene_id)
  end

  defp put_scene_id(attributes, _scene_id) do
    attributes
  end

  defp authenticated_hello(state, identity, claims, extensions) do
    presentation_negotiated = Enum.any?(extensions, &(&1["name"] == "presentation_v1"))
    view_negotiated = Enum.any?(extensions, &(&1["name"] == "view_v1"))

    view_origins_negotiated =
      Enum.any?(extensions, &(&1["name"] == "view_v1" and &1["origins"] == true))

    draw_policy_negotiated = Enum.any?(extensions, &(&1["name"] == "draw_policy_v1"))
    view_owner_negotiated =
      Enum.any?(extensions, &(&1["name"] == "view_v1" and &1["owner"] == true))

    with {:ok, welcome} <- Episode.connect(identity),
         # Taken once the connect check has passed, so a stored read that started while it waited,
         # possibly before the Participant's admission committed, cannot close this socket.
         connected_at = System.monotonic_time(:millisecond),
         :ok <- Authority.watch(identity.episode),
         {:ok, owner, owner_id, _views} <-
           ViewOwner.join(identity.episode, identity.participant_id) do
      Process.cancel_timer(state.hello_timer)
      Fanout.subscribe(identity.episode)
      Process.send_after(self(), :whiteboard_authority_tick, Authority.poll_ms())

      welcome =
        if presentation_negotiated do
          welcome
        else
          Map.delete(welcome, "presenting")
        end

      welcome =
        if view_owner_negotiated, do: Map.put(welcome, "view_owner_id", owner_id), else: welcome

      owner_ref = Process.monitor(owner)

      next =
        %{
          state
          | phase: :live,
            hello_timer: nil,
            identity: identity,
            connected_at: connected_at,
            display_name: claims.display_name,
            presentation_negotiated: presentation_negotiated,
            view_negotiated: view_negotiated,
            view_origins_negotiated: view_origins_negotiated,
            draw_policy_negotiated: draw_policy_negotiated,
            can_draw: welcome["can_draw"],
            view_owner_negotiated: view_owner_negotiated,
            view_owner: owner,
            view_owner_ref: owner_ref,
            scene_id: welcome["scene_id"],
            revision: String.to_integer(welcome["revision"])
        }
        |> observe_operation("connect", "accepted")

      send(self(), :whiteboard_v1_access_changed)
      {:push, {:text, Protocol.encode!(welcome)}, next}
    else
      {:error, :permission_denied} -> stop(state, 1008, "policy violation", :permission_denied)
      {:error, :authority_unavailable} -> dependency_unavailable(state, "authority")
      _unavailable -> stop(state, 1012, "dependency unavailable", :dependency_unavailable)
    end
  end
end
