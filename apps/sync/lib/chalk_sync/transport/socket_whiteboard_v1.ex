defmodule ChalkSync.Transport.SocketWhiteboardV1 do
  @moduledoc "Independent whiteboard-v1 WebSocket transport."

  @behaviour WebSock

  require Logger

  alias ChalkSync.Auth.Claims
  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.OutboundQueue
  alias ChalkSync.WhiteboardV1.Protocol
  alias ChalkSync.WhiteboardV1.Session

  @hello_timeout_ms 5_000

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
       scene_id: nil,
       revision: 0,
       snapshot: nil,
       cursor_window_started_at_ms: 0,
       cursor_window_count: 0,
       outbound: OutboundQueue.new(),
       observability: observability
     }}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, state) do
    case Protocol.decode(text) do
      {:ok, frame} -> handle_frame(frame, state)
      {:error, reason} -> {:stop, :normal, {1009, close_reason(reason)}, state}
    end
  end

  def handle_in({_payload, _options}, state),
    do: {:stop, :normal, {1009, "text frames only"}, state}

  @impl true
  def handle_info(:hello_timeout, %{phase: :awaiting_hello} = state),
    do: {:stop, :normal, {1008, "hello timeout"}, state}

  def handle_info(:hello_timeout, state), do: {:ok, state}

  def handle_info(
        {:whiteboard_v1_frame,
         %{"type" => "cursor", "participant_session_id" => participant_session_id}},
        %{identity: %Identity{participant_session_id: participant_session_id}} = state
      ),
      do: {:ok, state}

  def handle_info(
        {:whiteboard_v1_frame,
         %{"type" => "update", "scene_id" => scene_id, "revision" => revision} = frame},
        %{phase: :live, scene_id: scene_id} = state
      )
      when is_binary(revision) do
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
        case Session.read_after(identity, scene_id, state.revision) do
          {:ok, frames} when length(frames) == revision - state.revision ->
            enqueue_and_push(%{state | revision: revision}, frames)

          _unavailable ->
            enqueue_and_push(state, [
              %{
                "type" => "reset_required",
                "scene_id" => scene_id,
                "reason" => "gap"
              }
            ])
        end
    end
  end

  def handle_info({:whiteboard_v1_head, _scene_id, _revision}, state), do: {:ok, state}

  def handle_info(:whiteboard_drain, state), do: push_next(state)

  @impl true
  def terminate(_reason, %{identity: %Identity{session: session}} = state) do
    Fanout.unsubscribe(session)
    observe_terminal(state)
    :ok
  end

  def terminate(_reason, state) do
    observe_terminal(state)
    :ok
  end

  defp handle_frame({:hello, %{token: token}}, %{phase: :awaiting_hello} = state) do
    with {:ok, claims} <- TokenVerifier.verify(token),
         {:ok, identity} <- identity(claims),
         {:ok, welcome} <- Session.connect(identity) do
      Process.cancel_timer(state.hello_timer)
      Fanout.subscribe(identity.session)

      {:push, {:text, Protocol.encode!(welcome)},
       %{
         state
         | phase: :live,
           hello_timer: nil,
           identity: identity,
           display_name: claims.display_name,
           scene_id: welcome["scene_id"],
           revision: String.to_integer(welcome["revision"])
       }
       |> observe_operation("connect", "accepted")}
    else
      {:error, :invalid_token} -> {:stop, :normal, {1008, "invalid token"}, state}
      {:error, :invalid_identity} -> {:stop, :normal, {1008, "invalid token"}, state}
      {:error, :permission_denied} -> {:stop, :normal, {1008, "policy violation"}, state}
      _unavailable -> {:stop, :normal, {1012, "dependency unavailable"}, state}
    end
  end

  defp handle_frame({:hello, _hello}, state),
    do: {:stop, :normal, {1008, "already authenticated"}, state}

  defp handle_frame({:submit_update, operation}, %{phase: :live, identity: identity} = state) do
    case Session.submit_update(identity, operation) do
      {:ok, commit, update} ->
        Fanout.broadcast_local(identity.session, update)
        state = observe_operation(state, "submit_update", "committed")
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :submit_update, failure, state)
    end
  end

  defp handle_frame({:clear, operation}, %{phase: :live, identity: identity} = state) do
    case Session.clear(identity, operation) do
      {:ok, commit, reset} ->
        Fanout.broadcast_local(identity.session, reset)
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
    case Session.set_draw_permission(identity, operation) do
      {:ok, commit, permission} ->
        Fanout.broadcast_local(identity.session, permission)
        state = observe_operation(state, "set_draw_permission", "committed")
        {:push, {:text, Protocol.encode!(commit)}, state}

      failure ->
        operation_failure(operation.operation_id, :set_draw_permission, failure, state)
    end
  end

  defp handle_frame(
         {:request_snapshot, %{request_id: request_id}},
         %{phase: :live, identity: identity} = state
       ) do
    case Session.snapshot(identity, request_id) do
      {:ok, [first | remaining]} ->
        snapshot = %{
          request_id: request_id,
          scene_id: first["scene_id"],
          revision: first["revision"],
          acknowledged_page: -1,
          remaining: remaining
        }

        {:push, {:text, Protocol.encode!(first)},
         %{state | phase: :recovering, snapshot: snapshot}
         |> observe_operation("request_snapshot", "accepted")}

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
          {:ok,
           %{
             state
             | phase: :live,
               snapshot: nil,
               scene_id: snapshot.scene_id,
               revision: String.to_integer(snapshot.revision)
           }}
      end
    else
      {:stop, :normal, {1008, "invalid snapshot acknowledgement"}, state}
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
          "participant_session_id" => identity.participant_session_id,
          "display_name" => display_name,
          "x" => cursor.x,
          "y" => cursor.y,
          "occurred_at" =>
            DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
        }

        Fanout.publish_cursor(identity.session, frame)
        {:ok, next}

      :rate_limited ->
        {:ok, state}
    end
  end

  defp handle_frame({:ping, _ping}, state),
    do: {:push, {:text, Protocol.pong()}, state}

  defp handle_frame(_frame, state),
    do: {:stop, :normal, {1008, "operation not available in this phase"}, state}

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
    now_ms = System.monotonic_time(:millisecond)

    result =
      Enum.reduce_while(frames, {:ok, state.outbound}, fn frame, {:ok, queue} ->
        case OutboundQueue.push(queue, frame, now_ms) do
          {:ok, next} -> {:cont, {:ok, next}}
          {:error, reason} -> {:halt, {:error, reason}}
        end
      end)

    case result do
      {:ok, queue} ->
        push_next(%{state | outbound: queue})

      {:error, _reason} ->
        {:stop, :normal, {1012, "whiteboard delivery recovery required"}, state}
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
        {:stop, :normal, {1012, "whiteboard delivery recovery required"}, state}
    end
  end

  defp advance_cursor(state, %{"type" => type, "scene_id" => scene_id, "revision" => revision})
       when type in ["update", "commit"] do
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
           room_id: room_id,
           session_id: session_id,
           participant_session_id: participant_session_id,
           participant_session_generation: generation
         } = claims
       )
       when is_binary(tenant_id) and is_binary(room_id) and is_binary(session_id) and
              is_binary(participant_session_id) and is_integer(generation) and generation > 0 do
    {:ok,
     %Identity{
       session: %SessionKey{
         tenant_id: tenant_id,
         room_id: room_id,
         session_id: session_id
       },
       participant_session_id: participant_session_id,
       participant_session_generation: generation,
       admission_lifecycle_intent_id: claims.admission_lifecycle_intent_id,
       role: claims.initial_role,
       eligible_roles: claims.eligible_roles
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

  defp observe_operation(state, operation, outcome) do
    observability =
      Observability.phase(state.observability, "sync.whiteboard", %{
        operation: to_string(operation),
        outcome: outcome
      })

    %{state | observability: observability}
  end

  defp observe_terminal(state) do
    Observability.terminal(state.observability, "sync.websocket.closed", %{
      protocol: "whiteboard-v1",
      phase: state.phase
    })
  end
end
