defmodule ChalkSync.Transport.SocketWhiteboardV1 do
  @moduledoc "Independent whiteboard-v1 WebSocket transport."

  @behaviour WebSock

  alias ChalkSync.Admission
  alias ChalkSync.Auth.Claims
  alias ChalkSync.Auth.TokenVerifier
  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.Multipart
  alias ChalkSync.WhiteboardV1.OutboundQueue
  alias ChalkSync.WhiteboardV1.Protocol

  @hello_timeout_ms 5_000
  @multipart_timeout_ms GeneratedWhiteboardV1.limits()["multipartUpdateTimeoutMs"]
  @authority_check_interval_ms 1_000

  @impl true
  def init(options) do
    options = Map.new(options)
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)

    observability =
      options
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
       admission:
         Map.get(options, :admission) || Application.get_env(:chalk_sync, :admission) || Admission,
       verify_token: Map.get(options, :verify_token, &TokenVerifier.verify/1),
       connect_episode: Map.get(options, :connect_episode, &Episode.connect/1),
       stateholder:
         Map.get(options, :stateholder) ||
           Application.get_env(:chalk_sync, :stateholder) || Stateholder,
       whiteboard_registered?: false,
       cursor_budget: nil,
       authority_checked_at_ms: nil,
       authority_valid?: false,
       outbound: OutboundQueue.new(),
       observability: observability
     }}
  end

  @impl true
  def handle_in({text, [opcode: :text]}, state) do
    case Protocol.decode(text) do
      {:ok, frame} -> handle_authenticated_frame(frame, state)
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
      else: deliver_authorized_frame(state, frame)
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
      else: deliver_authorized_frame(state, frame)
  end

  def handle_info({:whiteboard_v1_frame, frame}, %{phase: :live} = state) do
    deliver_authorized_frame(state, frame)
  end

  def handle_info({:whiteboard_v1_frame, _frame}, state), do: {:ok, state}

  def handle_info(
        {:whiteboard_v1_head, scene_id, revision},
        %{phase: :live, identity: %Identity{}} = state
      ) do
    with_current_authority(state, "delivery", fn next ->
      handle_whiteboard_head(next, scene_id, revision)
    end)
  end

  def handle_info({:whiteboard_v1_head, _scene_id, _revision}, state), do: {:ok, state}

  def handle_info(:whiteboard_drain, %{identity: %Identity{}} = state) do
    with_current_authority(state, "delivery", &push_next/1)
  end

  def handle_info(:whiteboard_drain, state), do: push_next(state)

  defp handle_whiteboard_head(state, scene_id, revision) do
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
        replay_or_reset(state, state.identity, scene_id, revision)
    end
  end

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
  def terminate(_reason, %{identity: %Identity{episode: episode}} = state) do
    Fanout.unsubscribe(episode)

    if state.whiteboard_registered?,
      do: Admission.close_whiteboard(state.admission, state.identity)

    observe_terminal(state)
    :ok
  end

  def terminate(_reason, state) do
    observe_terminal(state)
    :ok
  end

  defp handle_frame(
         {:hello, %{token: token, extensions: extensions}},
         %{phase: :awaiting_hello} = state
       ) do
    presentation_negotiated =
      Enum.any?(extensions, &(&1["name"] == "presentation_v1"))

    with {:ok, claims} <- state.verify_token.(token),
         {:ok, identity} <- identity(claims),
         {:ok, welcome} <- state.connect_episode.(identity),
         {:ok, cursor_budget} <- Admission.open_whiteboard(state.admission, identity) do
      Process.cancel_timer(state.hello_timer)
      Fanout.subscribe(identity.episode)
      welcome = if presentation_negotiated, do: welcome, else: Map.delete(welcome, "presenting")

      {:push, {:text, Protocol.encode!(welcome)},
       %{
         state
         | phase: :live,
           hello_timer: nil,
           identity: identity,
           display_name: claims.display_name,
           presentation_negotiated: presentation_negotiated,
           scene_id: welcome["scene_id"],
           revision: String.to_integer(welcome["revision"]),
           whiteboard_registered?: true,
           cursor_budget: cursor_budget
       }
       |> observe_operation("connect", "accepted")}
    else
      {:error, :invalid_token} ->
        {:stop, :normal, {1008, "invalid token"}, state}

      {:error, :invalid_identity} ->
        {:stop, :normal, {1008, "invalid token"}, state}

      {:error, :permission_denied} ->
        {:stop, :normal, {1008, "policy violation"}, state}

      {:error, :overloaded} ->
        {:stop, :normal, {1012, "dependency unavailable"},
         observe_operation(state, "connect", "overloaded")}

      _unavailable ->
        {:stop, :normal, {1012, "dependency unavailable"}, state}
    end
  end

  defp handle_frame({:hello, _hello}, state),
    do: {:stop, :normal, {1008, "already authenticated"}, state}

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
          "participant_id" => identity.participant_id,
          "display_name" => display_name,
          "x" => cursor.x,
          "y" => cursor.y,
          "occurred_at" =>
            DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
        }

        Fanout.publish_cursor(identity.episode, frame)
        {:ok, next}

      {:error, :rate_limited} ->
        {:ok, observe_operation(state, "cursor", "rate_limited")}

      {:error, :overloaded} ->
        {:stop, :normal, {1012, "dependency unavailable"},
         observe_operation(state, "cursor", "overloaded")}

      {:error, :authority_revoked} ->
        {:stop, :normal, {1008, "policy violation"},
         observe_operation(state, "cursor", "authority_revoked")}

      {:error, :dependency_unavailable} ->
        {:stop, :normal, {1012, "dependency unavailable"},
         observe_operation(state, "cursor", "dependency_unavailable")}
    end
  end

  defp handle_frame({:ping, _ping}, state),
    do: {:push, {:text, Protocol.pong()}, state}

  defp handle_frame(_frame, state),
    do: {:stop, :normal, {1008, "operation not available in this phase"}, state}

  defp handle_authenticated_frame(frame, %{identity: %Identity{}} = state) do
    with_current_authority(state, "receive", fn next -> handle_frame(frame, next) end)
  end

  defp handle_authenticated_frame(frame, state), do: handle_frame(frame, state)

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
        {:stop, :normal, {1012, "whiteboard delivery recovery required"}, state}
    end
  end

  defp deliver_frame(state, frame) do
    next = advance_cursor(state, frame)
    enqueue_and_push(next, [frame])
  end

  defp deliver_authorized_frame(state, frame) do
    with_current_authority(state, "delivery", fn next -> deliver_frame(next, frame) end)
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
    with {:ok, state} <- refresh_authority(state),
         :ok <- Admission.admit_cursor(state.cursor_budget, state.identity) do
      {:ok, state}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp with_current_authority(state, operation, action) do
    case refresh_authority(state) do
      {:ok, next} ->
        action.(next)

      {:error, :authority_revoked} ->
        {:stop, :normal, {1008, "policy violation"},
         observe_operation(state, operation, "authority_revoked")}

      {:error, :dependency_unavailable} ->
        {:stop, :normal, {1012, "dependency unavailable"},
         observe_operation(state, operation, "dependency_unavailable")}
    end
  end

  defp refresh_authority(state) do
    now_ms = System.monotonic_time(:millisecond)

    if is_integer(state.authority_checked_at_ms) and
         now_ms - state.authority_checked_at_ms < @authority_check_interval_ms and
         state.authority_valid? do
      {:ok, state}
    else
      authority_check(state, now_ms)
    end
  end

  defp authority_check(state, now_ms) do
    result =
      try do
        state.stateholder.participant_authority(
          state.identity.episode,
          state.identity.participant_id,
          state.identity.participant_generation
        )
      rescue
        _exception -> {:retryable, :dependency_unavailable}
      catch
        :exit, _reason -> {:retryable, :dependency_unavailable}
      end

    case result do
      {:ok, _authority} ->
        {:ok, %{state | authority_checked_at_ms: now_ms, authority_valid?: true}}

      {:error, reason}
      when reason in [
             :episode_ended,
             :participant_inactive,
             :stale_participant_generation,
             :participant_stale,
             :episode_not_found
           ] ->
        {:error, :authority_revoked}

      {:error, reason} when reason in [:dependency_unavailable, :storage_unavailable] ->
        {:error, :dependency_unavailable}

      {:error, _reason} ->
        {:error, :authority_revoked}

      {:retryable, _reason} ->
        {:error, :dependency_unavailable}

      _other ->
        {:error, :dependency_unavailable}
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
