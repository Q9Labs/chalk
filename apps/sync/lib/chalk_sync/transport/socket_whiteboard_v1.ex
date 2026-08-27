defmodule ChalkSync.Transport.SocketWhiteboardV1 do
  @moduledoc "Independent whiteboard-v1 WebSocket transport."

  @behaviour WebSock

  alias ChalkSync.Auth.Claims
  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Diagnostics
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.Multipart
  alias ChalkSync.WhiteboardV1.OutboundQueue
  alias ChalkSync.WhiteboardV1.Protocol

  @hello_timeout_ms 5_000
  @multipart_timeout_ms GeneratedWhiteboardV1.limits()["multipartUpdateTimeoutMs"]

  @impl true
  def init(options) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)

    observability =
      options
      |> Map.new()
      |> Map.get(:observability)
      |> Observability.merge(nil)
      |> Observability.root("sync.websocket.handshake", %{
        transport: "websocket",
        protocol: "whiteboard-v1"
      })

    {:ok,
     %{
       phase: :awaiting_hello,
       hello_timer: timer,
       identity: nil,
       display_name: nil,
       presentation_negotiated: false,
       scene_id: nil,
       revision: 0,
       snapshot: nil,
       multipart: nil,
       multipart_timer: nil,
       cursor_window_started_at_ms: 0,
       cursor_window_count: 0,
       outbound: OutboundQueue.new(),
       terminal: nil,
       observability: observability
     }}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, state) do
    case Protocol.decode(text) do
      {:ok, frame} -> handle_frame(frame, state)
      {:error, reason} -> stop(state, 1009, close_reason(reason), :protocol_error)
    end
  end

  def handle_in({_payload, _options}, state),
    do: stop(state, 1009, "text frames only", :protocol_error)

  @impl true
  def handle_info(:hello_timeout, %{phase: :awaiting_hello} = state),
    do: stop(state, 1008, "hello timeout", :hello_timeout)

  def handle_info(:hello_timeout, state), do: {:ok, state}

  def handle_info(
        {:whiteboard_multipart_timeout, operation_id},
        %{multipart: %{operation_id: operation_id}} = state
      ) do
    state = %{state | multipart: nil, multipart_timer: nil}
    operation_failure(operation_id, :submit_update, {:retryable, :overloaded}, state)
  end

  def handle_info({:whiteboard_multipart_timeout, _operation_id}, state), do: {:ok, state}

  def handle_info(
        {:whiteboard_v1_frame, %{"type" => "cursor", "participant_id" => participant_id}},
        %{identity: %Identity{participant_id: participant_id}} = state
      ),
      do: {:ok, state}

  def handle_info(
        {:whiteboard_v1_frame, %{"type" => "presentation_updated"}},
        %{phase: :live, presentation_negotiated: false} = state
      ),
      do: {:ok, state}

  def handle_info(
        {:whiteboard_v1_frame,
         %{
           "type" => "presentation_updated",
           "scene_id" => scene_id,
           "revision" => revision
         } = frame},
        %{phase: :live, presentation_negotiated: true, scene_id: scene_id} = state
      ) do
    if String.to_integer(revision) <= state.revision,
      do: {:ok, state},
      else: deliver_frame(state, frame)
  end

  def handle_info(
        {:whiteboard_v1_frame, %{"type" => "presentation_updated"}},
        %{phase: :live} = state
      ),
      do: {:ok, state}

  def handle_info(
        {:whiteboard_v1_frame,
         %{"type" => type, "scene_id" => scene_id, "revision" => revision} = frame},
        %{phase: :live, scene_id: scene_id} = state
      )
      when type in ["update", "update_part"] and is_binary(revision) do
    if String.to_integer(revision) <= state.revision,
      do: {:ok, state},
      else: deliver_frame(state, frame)
  end

  def handle_info({:whiteboard_v1_frame, frame}, %{phase: :live} = state) do
    deliver_frame(state, frame)
  end

  def handle_info({:whiteboard_v1_frame, _frame}, state), do: {:ok, state}

  def handle_info(
        {:whiteboard_v1_head, scene_id, revision},
        %{phase: :live, identity: identity} = state
      ) do
    cond do
      scene_id != state.scene_id ->
        enqueue_and_push(
          %{state | scene_id: scene_id, revision: revision},
          [
            %{
              "type" => "reset_required",
              "scene_id" => scene_id,
              "reason" => "scene_changed"
            }
          ]
        )

      revision <= state.revision ->
        {:ok, state}

      true ->
        replay_or_reset(state, identity, scene_id, revision)
    end
  end

  def handle_info({:whiteboard_v1_head, _scene_id, _revision}, state), do: {:ok, state}

  def handle_info(:whiteboard_drain, state), do: push_next(state)

  defp replay_or_reset(state, identity, scene_id, revision) do
    case Episode.read_after(
           identity,
           scene_id,
           state.revision,
           state.presentation_negotiated
         ) do
      {:ok, frames} ->
        if frames_reach_revision?(frames, revision),
          do: enqueue_replay(state, scene_id, revision, frames),
          else: enqueue_gap_reset(state, scene_id)

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
    presentation_negotiated =
      Enum.any?(extensions, &(&1["name"] == "presentation_v1"))

    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, identity} <- identity(claims),
         {:ok, welcome} <- observe_connect_result(Episode.connect(identity), identity, state) do
      Process.cancel_timer(state.hello_timer)
      Fanout.subscribe(identity.episode)
      welcome = if presentation_negotiated, do: welcome, else: Map.delete(welcome, "presenting")

      next =
        %{
          state
          | phase: :live,
            hello_timer: nil,
            identity: identity,
            display_name: claims.display_name,
            presentation_negotiated: presentation_negotiated,
            scene_id: welcome["scene_id"],
            revision: String.to_integer(welcome["revision"])
        }
        |> observe_operation("connect", "accepted")

      Diagnostics.record(:whiteboard_connect_succeeded, identity,
        observability: next.observability,
        attributes: %{transport: :websocket}
      )

      {:push, {:text, Protocol.encode!(welcome)}, next}
    else
      {:error, :invalid_token} -> stop(state, 1008, "invalid token", :invalid_token)
      {:error, :invalid_identity} -> stop(state, 1008, "invalid token", :invalid_token)
      {:error, :permission_denied} -> stop(state, 1008, "policy violation", :permission_denied)
      _unavailable -> stop(state, 1012, "dependency unavailable", :dependency_unavailable)
    end
  end

  defp handle_frame({:hello, _hello}, state),
    do: stop(state, 1008, "already authenticated", :protocol_error)

  defp handle_frame({:submit_update, operation}, %{phase: :live, identity: identity} = state) do
    if is_nil(state.multipart) do
      submit_update(identity, operation, state)
    else
      operation_failure(
        operation.operation_id,
        :submit_update,
        {:retryable, :overloaded},
        state
      )
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
      {:ok, commit, permission} ->
        Fanout.broadcast_local(identity.episode, permission)
        state = observe_operation(state, "set_draw_permission", "committed")
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :set_draw_permission, failure, state)
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
         {:request_snapshot, %{request_id: request_id}},
         %{phase: :live, identity: identity} = state
       ) do
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
          %{state | phase: :recovering, snapshot: snapshot}
          |> observe_operation("request_snapshot", "accepted")

        Diagnostics.record(:whiteboard_recovery_started, identity,
          observability: next.observability,
          attributes: %{transport: :websocket}
        )

        {:push, {:text, Protocol.encode!(first)}, next}

      failure ->
        operation_failure(request_id, :request_snapshot, failure, state)
    end
  end

  defp handle_frame(
         {:snapshot_ack, acknowledgement},
         %{phase: :recovering, snapshot: snapshot} = state
       ) do
    expected_page = snapshot.acknowledged_page + 1

    if acknowledgement.request_id == snapshot.request_id and
         acknowledgement.scene_id == snapshot.scene_id and
         acknowledgement.revision == snapshot.revision and
         acknowledgement.page == expected_page do
      case snapshot.remaining do
        [next | remaining] ->
          next_snapshot = %{
            snapshot
            | acknowledged_page: expected_page,
              remaining: remaining
          }

          {:push, {:text, Protocol.encode!(next)}, %{state | snapshot: next_snapshot}}

        [] ->
          next =
            %{
              state
              | phase: :live,
                snapshot: nil,
                scene_id: snapshot.scene_id,
                revision: String.to_integer(snapshot.revision)
            }

          Diagnostics.record(:whiteboard_recovery_succeeded, next.identity,
            observability: next.observability,
            attributes: %{transport: :websocket}
          )

          {:ok, next}
      end
    else
      stop(state, 1008, "invalid snapshot acknowledgement", :invalid_acknowledgement)
    end
  end

  defp handle_frame(
         {:cursor, cursor},
         %{phase: :live, identity: identity, display_name: display_name} = state
       ) do
    case admit_cursor(state) do
      {:ok, next} ->
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
        {:ok, next}

      :rate_limited ->
        {:ok, state}
    end
  end

  defp handle_frame({:ping, _ping}, state),
    do: {:push, {:text, Protocol.pong()}, state}

  defp handle_frame(_frame, state),
    do: stop(state, 1008, "operation not available in this phase", :protocol_error)

  defp submit_update(identity, operation, state) do
    case Episode.submit_update(identity, operation) do
      {:ok, commit, updates} ->
        Enum.each(updates, &Fanout.broadcast_local(identity.episode, &1))
        state = observe_operation(state, "submit_update", "committed")
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :submit_update, failure, state)
    end
  end

  defp operation_failure(correlation_id, operation, failure, state) do
    {code, recoverable} =
      case failure do
        {:error, code} -> {normalize_error(code), false}
        {:retryable, code} -> {normalize_error(code), true}
        _ -> {:unavailable, true}
      end

    state = observe_operation(state, operation, Atom.to_string(code))

    {:push,
     {:text,
      Protocol.operation_error(
        correlation_id,
        operation,
        code,
        recoverable,
        error_message(code)
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
        if queue.frame_count > 0, do: send(self(), :whiteboard_drain)
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

  defp advance_cursor(state, _frame), do: state

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
       episode: %EpisodeKey{
         tenant_id: tenant_id,
         space_id: space_id,
         episode_id: episode_id
       },
       participant_id: participant_id,
       participant_generation: generation,
       admission_lifecycle_intent_id: claims.admission_lifecycle_intent_id,
       role: claims.role,
       capabilities: claims.capabilities
     }}
  end

  defp identity(_claims), do: {:error, :invalid_identity}

  defp normalize_error(code)
       when code in [
              :permission_denied,
              :invalid_payload,
              :stale_scene,
              :cursor_reset_required,
              :rate_limited,
              :overloaded,
              :storage_unavailable
            ],
       do: code

  defp normalize_error(_code), do: :unavailable

  defp error_message(:permission_denied), do: "Whiteboard permission denied"
  defp error_message(:invalid_payload), do: "Invalid whiteboard payload"
  defp error_message(:stale_scene), do: "Whiteboard scene changed"
  defp error_message(:cursor_reset_required), do: "Whiteboard snapshot required"
  defp error_message(:rate_limited), do: "Whiteboard cursor rate exceeded"
  defp error_message(:overloaded), do: "Whiteboard temporarily overloaded"
  defp error_message(:storage_unavailable), do: "Whiteboard storage unavailable"
  defp error_message(:unavailable), do: "Whiteboard unavailable"

  defp close_reason(:frame_too_large), do: "frame too large"
  defp close_reason(:invalid_json), do: "invalid JSON"
  defp close_reason(_reason), do: "invalid whiteboard frame"

  defp admit_cursor(state) do
    now_ms = System.monotonic_time(:millisecond)

    if now_ms - state.cursor_window_started_at_ms >= 1_000 do
      {:ok,
       %{
         state
         | cursor_window_started_at_ms: now_ms,
           cursor_window_count: 1
       }}
    else
      if state.cursor_window_count < 60,
        do: {:ok, %{state | cursor_window_count: state.cursor_window_count + 1}},
        else: :rate_limited
    end
  end

  defp frames_reach_revision?([], _revision), do: false

  defp frames_reach_revision?(frames, revision) do
    frames
    |> List.last()
    |> Map.get("revision")
    |> then(&(&1 == Integer.to_string(revision)))
  end

  defp cancel_timer(nil), do: :ok
  defp cancel_timer(timer), do: Process.cancel_timer(timer)

  defp enqueue_gap_reset(state, scene_id) do
    enqueue_and_push(state, [
      %{
        "type" => "reset_required",
        "scene_id" => scene_id,
        "reason" => "gap"
      }
    ])
  end

  defp enqueue_replay(state, scene_id, revision, frames) do
    case enqueue_frames(state.outbound, frames) do
      {:ok, queue} ->
        push_next(%{state | outbound: queue, revision: revision})

      {:error, _reason} ->
        # A valid multipart revision may intentionally exceed the ordinary
        # per-socket replay queue. Keep the socket alive and move the client to
        # paged snapshot recovery instead of exposing only a prefix.
        enqueue_gap_reset(state, scene_id)
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

  defp observe_connect_result({:ok, _welcome} = result, _identity, _state), do: result

  defp observe_connect_result({:error, reason} = result, identity, state) do
    Diagnostics.record(:whiteboard_connect_failed, identity,
      observability: state.observability,
      attributes: %{transport: :websocket, reason: connect_failure_reason(reason)}
    )

    result
  end

  defp observe_connect_result(result, identity, state) do
    Diagnostics.record(:whiteboard_connect_failed, identity,
      observability: state.observability,
      attributes: %{transport: :websocket, reason: :dependency_unavailable}
    )

    result
  end

  defp connect_failure_reason(:permission_denied), do: :permission_denied
  defp connect_failure_reason(_reason), do: :dependency_unavailable

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
    terminal = state.terminal || %{close_code: 1000, reason: terminal_reason(terminate_reason)}

    Observability.terminal(state.observability, "sync.websocket.closed", %{
      protocol: "whiteboard-v1",
      phase: state.phase,
      close_code: terminal.close_code,
      reason: terminal.reason
    })

    if state.identity do
      Diagnostics.record(:whiteboard_disconnect_observed, state.identity,
        observability: state.observability,
        attributes: %{
          transport: :websocket,
          close_code: terminal.close_code,
          reason: terminal.reason
        }
      )
    end
  end

  defp terminal_reason(:normal), do: :normal
  defp terminal_reason(_reason), do: :client_closed
end
